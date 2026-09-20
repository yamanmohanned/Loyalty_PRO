using System.Text;
using Walaa.Agent.Capture;
using Xunit;

namespace Walaa.Agent.Tests;

/// <summary>
/// The Fail-Open rule for the in-path capture modes (docs/legacy/CLAUDE_v3.md §4.6).
/// </summary>
/// <remarks>
/// <para>
/// §4.6 rule 3 requires this suite by name: "It is covered by a test that kills the
/// capture/parse side while asserting forwarding continues."
/// </para>
/// <para>
/// Every test below breaks the capture side in a different realistic way — it throws,
/// it hangs, it runs out of memory, it falls behind — and every one asserts the same
/// thing: <b>the receipt still reached the printer, whole and in order</b>. A store
/// losing the ability to print because a loyalty agent failed is the operational
/// failure this component exists to avoid.
/// </para>
/// </remarks>
public class ForwardFirstTests
{
    private static byte[] Receipt() =>
        ReceiptFixture.Receipt(Walaa.Agent.Parsing.ArabicText.Cp864, "INV-9824", "85,000");

    /// <summary>A sink that throws on every call — a parsing bug in the worst place.</summary>
    private sealed class ThrowingSink : ICaptureSink
    {
        public int Attempts { get; private set; }

        public void TryCapture(ReadOnlySpan<byte> bytes)
        {
            Attempts += 1;
            throw new InvalidOperationException("capture side is broken");
        }

        public void TryCompleteJob() => throw new InvalidOperationException("capture side is broken");
    }

    /// <summary>A sink that blocks for longer than any shop would tolerate.</summary>
    private sealed class HangingSink : ICaptureSink
    {
        public void TryCapture(ReadOnlySpan<byte> bytes) => Thread.Sleep(Timeout.Infinite);

        public void TryCompleteJob() => Thread.Sleep(Timeout.Infinite);
    }

    private sealed class OutOfMemorySink : ICaptureSink
    {
        public void TryCapture(ReadOnlySpan<byte> bytes) => throw new OutOfMemoryException();

        public void TryCompleteJob() => throw new OutOfMemoryException();
    }

    [Fact]
    public async Task ForwardsEveryByteWhenTheCaptureSideThrows()
    {
        var receipt = Receipt();
        var printer = new MemoryStream();
        var sink = new ThrowingSink();

        var forwarded = await PrintRelay.RelayAsync(
            new MemoryStream(receipt), printer, sink, CancellationToken.None);

        // The whole receipt, byte for byte, despite every capture call throwing.
        Assert.Equal(receipt.Length, forwarded);
        Assert.Equal(receipt, printer.ToArray());
        Assert.True(sink.Attempts > 0, "the sink should have been offered the bytes");
    }

    [Fact]
    public async Task ForwardsEveryByteWhenTheCaptureSideRunsOutOfMemory()
    {
        var receipt = Receipt();
        var printer = new MemoryStream();

        var forwarded = await PrintRelay.RelayAsync(
            new MemoryStream(receipt), printer, new OutOfMemorySink(), CancellationToken.None);

        Assert.Equal(receipt.Length, forwarded);
        Assert.Equal(receipt, printer.ToArray());
    }

    [Fact]
    public async Task DoesNotWaitForABlockedConsumer()
    {
        // The real sink, with nobody reading its channel. Once the buffer is full it
        // must drop rather than apply back-pressure to the print path.
        var receipt = Receipt();
        using var sink = new ChannelCaptureSink();
        var printer = new MemoryStream();

        var relay = Task.Run(async () =>
        {
            for (var i = 0; i < 200; i += 1)
            {
                await PrintRelay.RelayAsync(
                    new MemoryStream(receipt), printer, sink, CancellationToken.None);
            }
        });

        var finished = await Task.WhenAny(relay, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.True(finished == relay, "forwarding stalled behind the capture consumer");
        await relay;
        // 200 receipts through a 16-slot buffer that nobody drained: most were dropped,
        // and every one was still printed.
        Assert.Equal(receipt.Length * 200, printer.Length);
        Assert.True(sink.DroppedJobs > 0, "expected drops once the buffer filled");
    }

    [Fact]
    public async Task ASinkThatBlocksCannotUndoWhatWasAlreadyForwarded()
    {
        // `HangingSink` blocks inside TryCapture, violating the interface contract. The
        // relay cannot defend against that in-process — a sink that refuses to return
        // owns the thread. What it CANNOT do is un-print: the first chunk reached the
        // printer before the sink was ever consulted, which is the ordering §4.6 rule 2
        // exists to guarantee.
        //
        // Run on a background thread deliberately. With a MemoryStream every await
        // completes synchronously, so calling this inline would block the test itself —
        // which is exactly how this test was written the first time, and how it hung.
        var receipt = Receipt();
        var printer = new MemoryStream();

        var relay = Task.Run(() =>
            PrintRelay.RelayAsync(new MemoryStream(receipt), printer, new HangingSink(), CancellationToken.None));

        var finished = await Task.WhenAny(relay, Task.Delay(TimeSpan.FromSeconds(2)));
        Assert.NotSame(relay, finished); // it hangs, as constructed

        Assert.True(printer.Length > 0, "bytes should have reached the printer before the sink blocked");
    }

    [Fact]
    public async Task ForwardsBeforeItCaptures()
    {
        // The ordering §4.6 rule 2 actually requires: at the moment the sink is called,
        // the bytes are already at the printer. A sink that observes otherwise would
        // mean capture had been inserted ahead of forwarding.
        var receipt = Receipt();
        var printer = new MemoryStream();
        var observations = new List<(long Printed, int Captured)>();

        var sink = new InspectingSink(bytes => observations.Add((printer.Length, bytes.Length)));

        await PrintRelay.RelayAsync(new MemoryStream(receipt), printer, sink, CancellationToken.None);

        Assert.NotEmpty(observations);
        var totalCaptured = 0;
        foreach (var (printed, captured) in observations)
        {
            totalCaptured += captured;
            Assert.True(printed >= totalCaptured, $"captured {totalCaptured} bytes but only {printed} had been printed");
        }
    }

    private sealed class InspectingSink(Action<byte[]> onCapture) : ICaptureSink
    {
        public void TryCapture(ReadOnlySpan<byte> bytes) => onCapture(bytes.ToArray());

        public void TryCompleteJob()
        {
        }
    }

    [Fact]
    public async Task AssemblesWhatItCapturedIntoWholeJobs()
    {
        var receipt = Receipt();
        using var sink = new ChannelCaptureSink();

        await PrintRelay.RelayAsync(
            new MemoryStream(receipt), Stream.Null, sink, CancellationToken.None);

        Assert.True(sink.Jobs.TryRead(out var job));
        Assert.Equal(receipt, job);
    }

    [Fact]
    public async Task DropsAnOversizedJobRatherThanTruncatingIt()
    {
        // A truncated capture parses to a wrong total or no total, and §4.5's rule is
        // that a doubtful amount is worse than none.
        using var sink = new ChannelCaptureSink();
        var huge = new byte[1024 * 1024];
        Encoding.ASCII.GetBytes("الإجمالي 85,000").CopyTo(huge, 0);

        await PrintRelay.RelayAsync(new MemoryStream(huge), Stream.Null, sink, CancellationToken.None);

        Assert.False(sink.Jobs.TryRead(out _));
        Assert.Equal(1, sink.DroppedJobs);
    }

    [Fact]
    public async Task KeepsForwardingAfterTheCaptureConsumerDies()
    {
        // The scenario in §4.6's own words: kill the capture side mid-operation and
        // assert printing continues.
        var receipt = Receipt();
        using var sink = new ChannelCaptureSink();
        var printer = new MemoryStream();
        using var consumerDead = new CancellationTokenSource();

        var consumer = Task.Run(async () =>
        {
            await foreach (var _ in sink.Jobs.ReadAllAsync(consumerDead.Token))
            {
                // Consume one job, then die.
                await consumerDead.CancelAsync();
            }
        });

        await PrintRelay.RelayAsync(new MemoryStream(receipt), printer, sink, CancellationToken.None);
        try
        {
            await consumer;
        }
        catch (OperationCanceledException)
        {
        }

        // Consumer is gone. Everything after this point still prints.
        for (var i = 0; i < 50; i += 1)
        {
            await PrintRelay.RelayAsync(new MemoryStream(receipt), printer, sink, CancellationToken.None);
        }

        Assert.Equal(receipt.Length * 51, printer.Length);
    }
}
