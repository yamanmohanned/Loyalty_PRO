using System.Net;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Walaa.Agent.Capture;
using Walaa.Agent.Delivery;
using Walaa.Agent.Parsing;

namespace Walaa.Agent;

/// <summary>
/// The agent, assembled: capture → parse → queue → deliver (CLAUDE_v3.md §4).
/// </summary>
/// <remarks>
/// <para>
/// Three loops that deliberately do not touch each other. Capture runs on the print
/// path and does nothing but forward and hand off. Parsing drains the sink's channel on
/// its own thread. Delivery drains the disk queue on a timer. A failure in any one of
/// them cannot reach back into the one before it — which is the whole architecture of
/// §4.6 expressed in the shape of the code.
/// </para>
/// </remarks>
public sealed class AgentWorker(
    AgentSettings settings,
    CaptureQueue queue,
    IngestClient ingest,
    ILogger<AgentWorker> logger,
    ILoggerFactory loggerFactory) : BackgroundService
{
    private static readonly TimeSpan DeliveryInterval = TimeSpan.FromSeconds(15);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        queue.EnsureCreated();

        var template = LoadTemplate();
        var parser = new ReceiptParser(template);

        using var sink = new ChannelCaptureSink();
        await using var mode = await StartCaptureAsync(sink, stoppingToken).ConfigureAwait(false);

        if (mode is null)
        {
            logger.LogError("no capture mode could be started; the agent will idle");
        }

        var parsing = ParseLoopAsync(sink, parser, mode?.Mode ?? CaptureMode.SpoolWatch, stoppingToken);
        var delivering = DeliveryLoopAsync(stoppingToken);

        await Task.WhenAll(parsing, delivering).ConfigureAwait(false);
    }

    private PosTemplate LoadTemplate()
    {
        var path = Path.IsPathRooted(settings.TemplatePath)
            ? settings.TemplatePath
            : Path.Combine(AppContext.BaseDirectory, settings.TemplatePath);

        try
        {
            var template = PosTemplate.Load(path);
            logger.LogInformation("parsing with template '{Name}' v{Version}", template.Name, template.Version);
            return template;
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException)
        {
            // A broken template must not stop capture. Receipts still queue with a
            // parse failure attached, which is what the calibration screen exists to
            // resolve — and losing the captures instead would be irreversible.
            logger.LogError(error, "could not load {Path}; falling back to the built-in template", path);
            return new PosTemplate();
        }
    }

    /// <summary>Starts the configured mode, or detects one on a fresh install (§4.3).</summary>
    private async Task<ICaptureMode?> StartCaptureAsync(ICaptureSink sink, CancellationToken token)
    {
        var chosen = settings.Mode;

        if (chosen is null)
        {
            logger.LogInformation("no capture mode configured; running detection");
            var detector = new CaptureDetector(loggerFactory.CreateLogger<CaptureDetector>());
            var result = await detector
                .DetectAsync(BuildCandidates(), TimeSpan.FromSeconds(30), token)
                .ConfigureAwait(false);

            logger.LogInformation("detection: {Reason}", result.Reason);
            chosen = result.Selected;
        }

        if (chosen is null)
        {
            return null;
        }

        var mode = Build(chosen.Value);
        if (mode is null)
        {
            logger.LogError("capture mode {Mode} is configured but not fully set up", chosen);
            return null;
        }

        var probe = await mode.ProbeAsync(token).ConfigureAwait(false);
        if (!probe.Available)
        {
            logger.LogError("capture mode {Mode} unavailable: {Detail}", chosen, probe.Detail);
            await mode.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        await mode.StartAsync(sink, token).ConfigureAwait(false);
        logger.LogInformation(
            "capturing with {Mode} ({Path})",
            chosen,
            chosen.Value.IsInPath() ? "in the print path" : "out of the print path");
        return mode;
    }

    private IReadOnlyList<ICaptureMode> BuildCandidates()
    {
        var candidates = new List<ICaptureMode>();
        foreach (var mode in Enum.GetValues<CaptureMode>())
        {
            var built = Build(mode);
            if (built is not null)
            {
                candidates.Add(built);
            }
        }

        return candidates;
    }

    private ICaptureMode? Build(CaptureMode mode) => mode switch
    {
        CaptureMode.SpoolWatch => new SpoolWatchCapture(
            settings.SpoolDirectory ?? SpoolWatchCapture.DefaultSpoolDirectory,
            loggerFactory.CreateLogger<SpoolWatchCapture>()),

        CaptureMode.VirtualPrinter when
            settings.VirtualPrinterDropDirectory is { } drop && settings.RealPrinterName is { } printer =>
            new VirtualPrinterCapture(drop, printer, loggerFactory.CreateLogger<VirtualPrinterCapture>()),

        CaptureMode.SerialBridge when
            settings.VirtualComPort is { } virtualPort && settings.RealComPort is { } realPort =>
            new SerialBridgeCapture(
                new SerialBridgeCapture.PortSettings(virtualPort, realPort),
                loggerFactory.CreateLogger<SerialBridgeCapture>()),

        CaptureMode.NetworkProxy when TryParseEndpoint(settings.PrinterAddress) is { } printer =>
            new NetworkProxyCapture(
                new IPEndPoint(IPAddress.Any, settings.NetworkListenPort),
                printer,
                loggerFactory.CreateLogger<NetworkProxyCapture>()),

        _ => null,
    };

    private static IPEndPoint? TryParseEndpoint(string? value) =>
        value is not null && IPEndPoint.TryParse(value, out var endpoint) ? endpoint : null;

    /// <summary>Parses captured jobs and queues what it can read.</summary>
    private async Task ParseLoopAsync(
        ChannelCaptureSink sink,
        ReceiptParser parser,
        CaptureMode mode,
        CancellationToken token)
    {
        try
        {
            await foreach (var job in sink.Jobs.ReadAllAsync(token).ConfigureAwait(false))
            {
                var result = parser.Parse(job);

                if (!result.Success)
                {
                    // Not queued, and said plainly in the log: an invoice with no total
                    // cannot be ingested, and guessing one would corrupt a balance
                    // (§4.5). This is the signal the calibration flow acts on.
                    logger.LogWarning(
                        "capture not parsed ({Failure}); {Bytes} bytes, codepage {Codepage}",
                        result.Failure,
                        job.Length,
                        result.Codepage);
                    continue;
                }

                var now = DateTimeOffset.UtcNow;
                await queue.EnqueueAsync(
                    new CapturedInvoice
                    {
                        InvoiceId = result.InvoiceId!,
                        AmountGross = result.AmountGross!.Value,
                        BranchId = settings.BranchCode,
                        OccurredAt = now.ToString("O"),
                        CapturedAt = now.ToString("O"),
                        CaptureMode = ToWireMode(mode),
                        // Generated once, here. Every later retry reuses it (§4.8).
                        IdempotencyKey = Guid.NewGuid().ToString(),
                        RawText = settings.RetainReceiptText ? result.Text : null,
                    },
                    token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    /// <summary>The Normalized Invoice Schema's spelling of the capture mode.</summary>
    private static string ToWireMode(CaptureMode mode) => mode switch
    {
        CaptureMode.SpoolWatch => "SPOOL_WATCH",
        CaptureMode.VirtualPrinter => "VIRTUAL_PRINTER",
        CaptureMode.SerialBridge => "SERIAL_BRIDGE",
        CaptureMode.NetworkProxy => "NETWORK_PROXY",
        _ => "MANUAL",
    };

    /// <summary>Drains the disk queue to the manager machine.</summary>
    private async Task DeliveryLoopAsync(CancellationToken token)
    {
        var signedIn = false;

        while (!token.IsCancellationRequested)
        {
            try
            {
                if (!signedIn)
                {
                    signedIn = await ingest
                        .SignInAsync(settings.Username, settings.Password, token)
                        .ConfigureAwait(false);
                }

                if (signedIn)
                {
                    foreach (var (path, invoice) in queue.Pending())
                    {
                        var result = await ingest
                            .DeliverAsync(settings.AgentId, invoice, token)
                            .ConfigureAwait(false);

                        if (result.Settled)
                        {
                            queue.Settle(path);
                            logger.LogInformation(
                                "delivered {InvoiceId}{Duplicate}",
                                invoice.InvoiceId,
                                result.Duplicate ? " (already recorded)" : string.Empty);
                        }
                        else if (!result.Retryable)
                        {
                            // The server will never accept this capture as it stands.
                            // Set it aside so it is neither lost nor blocking the queue.
                            queue.Quarantine(path, result.Detail);
                        }
                        else
                        {
                            // Stop the pass rather than hammering an unreachable
                            // manager for every queued item in turn.
                            if (result.Detail == "token expired")
                            {
                                signedIn = false;
                            }

                            break;
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception error)
            {
                // Delivery must never take the agent down: capture is the part that
                // cannot be redone later.
                logger.LogError(error, "delivery pass failed");
            }

            try
            {
                await Task.Delay(DeliveryInterval, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }
}
