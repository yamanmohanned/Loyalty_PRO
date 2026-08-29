using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging.Abstractions;
using Walaa.Agent.Capture;
using Walaa.Agent.Parsing;
using Xunit;

namespace Walaa.Agent.Tests;

/// <summary>
/// The four capture modes (CLAUDE_v3.md §4.2) and how one is chosen (§4.3).
/// </summary>
public class CaptureTests
{
    private static byte[] Receipt() => ReceiptFixture.Receipt(ArabicText.Cp864, "INV-9824", "85,000");

    /* ── NETWORK_PROXY ─────────────────────────────────────────────────────── */

    /// <summary>Stands in for the network printer: accepts one connection and records it.</summary>
    private sealed class FakePrinter : IAsyncDisposable
    {
        private readonly TcpListener _listener;
        private readonly TaskCompletionSource<byte[]> _received = new();

        public FakePrinter()
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            _ = AcceptAsync();
        }

        public IPEndPoint Endpoint => (IPEndPoint)_listener.LocalEndpoint;

        public Task<byte[]> Received => _received.Task;

        private async Task AcceptAsync()
        {
            try
            {
                using var client = await _listener.AcceptTcpClientAsync();
                using var buffer = new MemoryStream();
                await client.GetStream().CopyToAsync(buffer);
                _received.TrySetResult(buffer.ToArray());
            }
            catch (Exception error)
            {
                _received.TrySetException(error);
            }
        }

        public ValueTask DisposeAsync()
        {
            _listener.Stop();
            return ValueTask.CompletedTask;
        }
    }

    [Fact]
    public async Task NetworkProxyForwardsToThePrinterAndCapturesACopy()
    {
        await using var printer = new FakePrinter();
        using var sink = new ChannelCaptureSink();

        await using var proxy = new NetworkProxyCapture(
            new IPEndPoint(IPAddress.Loopback, 0), printer.Endpoint, NullLogger<NetworkProxyCapture>.Instance);
        await proxy.StartAsync(sink, CancellationToken.None);

        var receipt = Receipt();
        using (var pos = new TcpClient())
        {
            await pos.ConnectAsync(proxy.ListenEndpoint);
            await pos.GetStream().WriteAsync(receipt);
            await pos.GetStream().FlushAsync();
        }

        // The printer got the bytes, unchanged. This is the property that matters most:
        // the customer's receipt is identical to the one the POS composed.
        var printed = await printer.Received.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(receipt, printed);

        // And the agent kept a copy it can parse.
        var job = await ReadOneJob(sink, TimeSpan.FromSeconds(5));
        Assert.Equal(receipt, job);
    }

    [Fact]
    public async Task NetworkProxyStillPrintsWhenTheCaptureSideThrows()
    {
        await using var printer = new FakePrinter();

        await using var proxy = new NetworkProxyCapture(
            new IPEndPoint(IPAddress.Loopback, 0), printer.Endpoint, NullLogger<NetworkProxyCapture>.Instance);
        await proxy.StartAsync(new ExplodingSink(), CancellationToken.None);

        var receipt = Receipt();
        using (var pos = new TcpClient())
        {
            await pos.ConnectAsync(proxy.ListenEndpoint);
            await pos.GetStream().WriteAsync(receipt);
        }

        // §4.6 through a real socket, not just a MemoryStream.
        Assert.Equal(receipt, await printer.Received.WaitAsync(TimeSpan.FromSeconds(10)));
    }

    private sealed class ExplodingSink : ICaptureSink
    {
        public void TryCapture(ReadOnlySpan<byte> bytes) => throw new InvalidOperationException();

        public void TryCompleteJob() => throw new InvalidOperationException();
    }

    [Fact]
    public async Task NetworkProxyProbeReportsAPortItCannotHave()
    {
        // Something else is already listening where the POS would be told to connect.
        using var squatter = new TcpListener(IPAddress.Loopback, 0);
        squatter.Start();
        var taken = (IPEndPoint)squatter.LocalEndpoint;

        await using var proxy = new NetworkProxyCapture(
            taken, new IPEndPoint(IPAddress.Loopback, 9100), NullLogger<NetworkProxyCapture>.Instance);

        var probe = await proxy.ProbeAsync(CancellationToken.None);

        Assert.False(probe.Available);
        Assert.Contains(taken.Port.ToString(), probe.Detail, StringComparison.Ordinal);
    }

    /* ── SPOOL_WATCH ───────────────────────────────────────────────────────── */

    [Fact]
    public async Task SpoolWatchCapturesAFinishedJob()
    {
        var directory = Directory.CreateTempSubdirectory("walaa-spool-").FullName;
        try
        {
            using var sink = new ChannelCaptureSink();
            await using var watcher = new SpoolWatchCapture(
                directory, NullLogger<SpoolWatchCapture>.Instance, TimeSpan.FromMilliseconds(50));
            await watcher.StartAsync(sink, CancellationToken.None);

            var receipt = Receipt();
            await File.WriteAllBytesAsync(Path.Combine(directory, "00004.SPL"), receipt);

            var job = await ReadOneJob(sink, TimeSpan.FromSeconds(10));
            Assert.Equal(receipt, job);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task SpoolWatchIgnoresAJobThatVanishesBeforeItSettles()
    {
        // The spooler deletes a job the moment the printer confirms it. That is the
        // normal end of a successful print, not an error — the receipt printed and the
        // agent simply did not get a copy.
        var directory = Directory.CreateTempSubdirectory("walaa-spool-").FullName;
        try
        {
            using var sink = new ChannelCaptureSink();
            await using var watcher = new SpoolWatchCapture(
                directory, NullLogger<SpoolWatchCapture>.Instance, TimeSpan.FromMilliseconds(200));
            await watcher.StartAsync(sink, CancellationToken.None);

            var path = Path.Combine(directory, "00005.SPL");
            await File.WriteAllBytesAsync(path, Receipt());
            File.Delete(path);

            await Task.Delay(TimeSpan.FromSeconds(1));
            Assert.False(sink.Jobs.TryRead(out _));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task SpoolWatchProbeFailsWhenTheDirectoryIsMissing()
    {
        await using var watcher = new SpoolWatchCapture(
            Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}"),
            NullLogger<SpoolWatchCapture>.Instance);

        var probe = await watcher.ProbeAsync(CancellationToken.None);
        Assert.False(probe.Available);
    }

    [Fact]
    public void SpoolWatchIsTheOnlyModeOutOfThePrintPath()
    {
        // The fact the whole preference rests on (§4.6).
        Assert.False(CaptureMode.SpoolWatch.IsInPath());
        Assert.True(CaptureMode.VirtualPrinter.IsInPath());
        Assert.True(CaptureMode.SerialBridge.IsInPath());
        Assert.True(CaptureMode.NetworkProxy.IsInPath());
    }

    /* ── Auto-detection (§4.3, §4.6 rule 1) ────────────────────────────────── */

    /// <summary>A mode that reports whatever the test needs it to.</summary>
    private sealed class FakeMode(CaptureMode mode, bool available, int jobs, int bytesPerJob = 128) : ICaptureMode
    {
        public bool Started { get; private set; }

        public CaptureMode Mode => mode;

        public Task<ProbeResult> ProbeAsync(CancellationToken cancellationToken) =>
            Task.FromResult(available ? ProbeResult.Yes("ok") : ProbeResult.No("no"));

        public Task StartAsync(ICaptureSink sink, CancellationToken cancellationToken)
        {
            Started = true;
            for (var i = 0; i < jobs; i += 1)
            {
                sink.TryCapture(new byte[bytesPerJob]);
                sink.TryCompleteJob();
            }

            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private static CaptureDetector Detector() => new(NullLogger<CaptureDetector>.Instance);

    [Fact]
    public async Task DetectionPrefersSpoolWatchWheneverItYieldsData()
    {
        // The rule from §4.6 rule 1, and the reason it exists: spool watching is the only
        // mode that cannot stop a shop printing, so it wins even when an in-path mode
        // would capture more.
        var spool = new FakeMode(CaptureMode.SpoolWatch, available: true, jobs: 1);
        var proxy = new FakeMode(CaptureMode.NetworkProxy, available: true, jobs: 50);

        var result = await Detector().DetectAsync(
            [proxy, spool], TimeSpan.FromMilliseconds(50), CancellationToken.None);

        Assert.Equal(CaptureMode.SpoolWatch, result.Selected);
    }

    [Fact]
    public async Task DetectionStopsAsSoonAsSpoolWatchSucceeds()
    {
        // Not merely preferred in the ranking — evaluated first and short-circuited, so a
        // store where it works never has an in-path mode started even for a moment.
        var spool = new FakeMode(CaptureMode.SpoolWatch, available: true, jobs: 1);
        var serial = new FakeMode(CaptureMode.SerialBridge, available: true, jobs: 5);

        var result = await Detector().DetectAsync(
            [serial, spool], TimeSpan.FromMilliseconds(50), CancellationToken.None);

        Assert.Equal(CaptureMode.SpoolWatch, result.Selected);
        Assert.False(serial.Started, "an in-path mode was started even though spool watching worked");
    }

    [Fact]
    public async Task DetectionFallsThroughToAnInPathModeWhenSpoolWatchSeesNothing()
    {
        var spool = new FakeMode(CaptureMode.SpoolWatch, available: true, jobs: 0);
        var proxy = new FakeMode(CaptureMode.NetworkProxy, available: true, jobs: 3);

        var result = await Detector().DetectAsync(
            [spool, proxy], TimeSpan.FromMilliseconds(50), CancellationToken.None);

        Assert.Equal(CaptureMode.NetworkProxy, result.Selected);
    }

    [Fact]
    public async Task DetectionSelectsNothingWhenNoReceiptWasPrinted()
    {
        // "Saw nothing" is not "cannot work". The report has to let the settings screen
        // say "no receipt was printed during the check" rather than condemn every mode.
        var modes = new[]
        {
            new FakeMode(CaptureMode.SpoolWatch, available: true, jobs: 0),
            new FakeMode(CaptureMode.NetworkProxy, available: true, jobs: 0),
        };

        var result = await Detector().DetectAsync(modes, TimeSpan.FromMilliseconds(50), CancellationToken.None);

        Assert.Null(result.Selected);
        Assert.All(result.Reports, report => Assert.True(report.Probe.Available));
        Assert.Contains("فاتورة", result.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DetectionReportsEveryModeEvenTheUnavailableOnes()
    {
        var modes = new[]
        {
            new FakeMode(CaptureMode.SpoolWatch, available: false, jobs: 0),
            new FakeMode(CaptureMode.SerialBridge, available: false, jobs: 0),
            new FakeMode(CaptureMode.NetworkProxy, available: true, jobs: 2),
        };

        var result = await Detector().DetectAsync(modes, TimeSpan.FromMilliseconds(50), CancellationToken.None);

        Assert.Equal(CaptureMode.NetworkProxy, result.Selected);
        Assert.Equal(3, result.Reports.Count);
    }

    /* ── Helpers ───────────────────────────────────────────────────────────── */

    private static async Task<byte[]> ReadOneJob(ChannelCaptureSink sink, TimeSpan timeout)
    {
        using var cancellation = new CancellationTokenSource(timeout);
        return await sink.Jobs.ReadAsync(cancellation.Token);
    }
}
