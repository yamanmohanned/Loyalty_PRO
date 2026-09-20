using System.IO.Ports;
using Microsoft.Extensions.Logging;

namespace Walaa.Agent.Capture;

/// <summary>
/// Bridges a virtual COM port to the real one (docs/legacy/CLAUDE_v3.md §4.2).
/// </summary>
/// <remarks>
/// <para>
/// For a POS that writes bytes straight to a serial port. A virtual COM pair (com0com)
/// is installed, Al-Bayan is pointed at one end, and the agent reads that end and
/// forwards to the port the printer is actually on.
/// </para>
/// <para>
/// <b>In-path (§4.6).</b> With the agent stopped, the POS writes into a virtual port
/// with nothing on the other side and the receipt is lost silently — worse than a
/// visible failure. The manual revert is therefore the important part of the setup
/// guide for this mode: point Al-Bayan back at the real COM port.
/// </para>
/// <para>
/// Streams are opened through a factory so the bridge can be exercised without two
/// physical ports; the production factory opens <see cref="SerialPort"/>s.
/// </para>
/// </remarks>
public sealed class SerialBridgeCapture(
    SerialBridgeCapture.PortSettings settings,
    ILogger<SerialBridgeCapture> logger,
    Func<string, SerialBridgeCapture.PortSettingsOpen>? open = null) : ICaptureMode
{
    /// <param name="VirtualPort">The port Al-Bayan writes to, e.g. <c>COM8</c>.</param>
    /// <param name="RealPort">The port the printer is on, e.g. <c>COM1</c>.</param>
    public readonly record struct PortSettings(
        string VirtualPort,
        string RealPort,
        int BaudRate = 9600,
        Parity Parity = Parity.None,
        int DataBits = 8,
        StopBits StopBits = StopBits.One);

    // A property, not a field initialiser: `DefaultOpen` is an instance method and
    // cannot be referenced before construction completes.
    private Func<string, PortSettingsOpen> Open => open ?? DefaultOpen;

    private CancellationTokenSource? _stopping;
    private Task? _pump;
    private PortSettingsOpen? _virtual;
    private PortSettingsOpen? _real;

    public CaptureMode Mode => CaptureMode.SerialBridge;

    private PortSettingsOpen DefaultOpen(string portName)
    {
        var port = new SerialPort(portName, settings.BaudRate, settings.Parity, settings.DataBits, settings.StopBits)
        {
            // The receipt arrives as a stream with no framing; timeouts are handled by
            // the relay's cancellation rather than by the port giving up mid-job.
            ReadTimeout = SerialPort.InfiniteTimeout,
            WriteTimeout = 5000,
        };
        port.Open();
        return new PortSettingsOpen(port.BaseStream, port);
    }

    public Task<ProbeResult> ProbeAsync(CancellationToken cancellationToken)
    {
        var present = SerialPort.GetPortNames();

        if (!present.Contains(settings.VirtualPort, StringComparer.OrdinalIgnoreCase))
        {
            return Task.FromResult(ProbeResult.No(
                $"المنفذ الوسيط {settings.VirtualPort} غير موجود — هل تم تثبيت com0com؟"));
        }

        if (!present.Contains(settings.RealPort, StringComparer.OrdinalIgnoreCase))
        {
            return Task.FromResult(ProbeResult.No($"منفذ الطابعة {settings.RealPort} غير موجود"));
        }

        return Task.FromResult(ProbeResult.Yes(
            $"{settings.VirtualPort} ← الكاشير، {settings.RealPort} ← الطابعة"));
    }

    public Task StartAsync(ICaptureSink sink, CancellationToken cancellationToken)
    {
        _stopping = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        _virtual = Open(settings.VirtualPort);
        _real = Open(settings.RealPort);

        logger.LogInformation(
            "bridging {Virtual} -> {Real}", settings.VirtualPort, settings.RealPort);

        _pump = PumpAsync(sink, _stopping.Token);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Forwards continuously, ending a job when the line goes quiet.
    /// </summary>
    /// <remarks>
    /// A serial port has no end-of-job marker: the receipt simply stops arriving. So a
    /// job boundary is an idle gap, long enough not to split a receipt that pauses while
    /// the POS composes its next line, short enough that the capture is not still
    /// waiting when the customer reaches the station.
    /// </remarks>
    private async Task PumpAsync(ICaptureSink sink, CancellationToken token)
    {
        var idleSink = new IdleJobSink(sink, TimeSpan.FromSeconds(2));

        try
        {
            await PrintRelay.RelayAsync(_virtual!.Stream, _real!.Stream, idleSink, token)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException error)
        {
            logger.LogError(error, "serial bridge failed");
        }
        finally
        {
            await idleSink.DisposeAsync().ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stopping?.Cancel();

        if (_pump is not null)
        {
            try
            {
                await _pump.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        _virtual?.Dispose();
        _real?.Dispose();
        _stopping?.Dispose();
    }

    /// <summary>An opened port: the stream to relay, plus whatever owns it.</summary>
    public sealed record PortSettingsOpen(Stream Stream, IDisposable? Owner) : IDisposable
    {
        public void Dispose()
        {
            Stream.Dispose();
            Owner?.Dispose();
        }
    }
}

/// <summary>
/// Wraps a sink and ends the job after a period of silence.
/// </summary>
/// <remarks>
/// For transports with no end-of-job signal (serial, and a network connection that is
/// held open across receipts). The timer runs on the thread pool, never on the print
/// path, and <see cref="TryCapture"/> stays the non-allocating pass-through the relay
/// requires.
/// </remarks>
public sealed class IdleJobSink : ICaptureSink, IAsyncDisposable
{
    private readonly ICaptureSink _inner;
    private readonly TimeSpan _idleFor;
    private readonly Timer _timer;
    private readonly Lock _gate = new();
    private bool _pending;

    public IdleJobSink(ICaptureSink inner, TimeSpan idleFor)
    {
        _inner = inner;
        _idleFor = idleFor;

        // Constructed with the real callback rather than a placeholder. An earlier
        // version used `_ => { }` in a field initialiser to avoid referencing `this`
        // before construction finished — which compiled, ran, and silently never ended
        // a job, leaving every serial capture buffered forever.
        _timer = new Timer(_ => OnIdle(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public void TryCapture(ReadOnlySpan<byte> bytes)
    {
        _inner.TryCapture(bytes);

        try
        {
            lock (_gate)
            {
                _pending = true;
            }

            // Push the deadline out on every chunk: the job ends when the bytes stop.
            _timer.Change(_idleFor, Timeout.InfiniteTimeSpan);
        }
        catch
        {
            // The print path never learns about a failing timer.
        }
    }

    public void TryCompleteJob()
    {
        lock (_gate)
        {
            _pending = false;
        }

        _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        _inner.TryCompleteJob();
    }

    /// <summary>Called by the timer once the transport has gone quiet.</summary>
    private void OnIdle()
    {
        bool complete;
        lock (_gate)
        {
            complete = _pending;
            _pending = false;
        }

        if (complete)
        {
            _inner.TryCompleteJob();
        }
    }

    public ValueTask DisposeAsync()
    {
        OnIdle();
        _timer.Dispose();
        return ValueTask.CompletedTask;
    }
}
