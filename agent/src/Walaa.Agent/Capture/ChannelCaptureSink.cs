using System.Threading.Channels;

namespace Walaa.Agent.Capture;

/// <summary>
/// The default sink: buffers captured bytes in memory and hands complete print jobs to
/// a consumer running on its own thread (docs/legacy/CLAUDE_v3.md §4.6 rule 2).
/// </summary>
/// <remarks>
/// <para>
/// The channel is <b>bounded</b> and drops on overflow. That is the whole design in one
/// property: if the consumer stalls — a slow disk, a wedged parse, a network call that
/// will not return — the producer, which is the print path, must not notice. It drops
/// the capture and keeps printing.
/// </para>
/// <para>
/// Bytes are copied out of the caller's buffer immediately, because the relay reuses
/// that buffer on its next read. A sink that held the span would be reading the next
/// chunk of the receipt by the time the consumer looked at it.
/// </para>
/// </remarks>
public sealed class ChannelCaptureSink : ICaptureSink, IDisposable
{
    /// <summary>
    /// How many complete jobs may wait. A till prints a few receipts a minute; a
    /// backlog of sixteen means the consumer has been stuck for minutes and the oldest
    /// captures are the least useful ones to keep.
    /// </summary>
    private const int JobCapacity = 16;

    /// <summary>
    /// Cap on one job's size. A receipt is kilobytes; anything past this is a raster
    /// image dump or a runaway, and buffering it would trade the shop's memory for a
    /// capture that will not parse anyway.
    /// </summary>
    private const int MaxJobBytes = 512 * 1024;

    private readonly Channel<byte[]> _jobs = Channel.CreateBounded<byte[]>(
        new BoundedChannelOptions(JobCapacity)
        {
            // `Wait` combined with `TryWrite` — NOT `DropWrite`.
            //
            // Both are non-blocking from `TryWrite`, but `DropWrite` discards silently
            // and returns true, so the agent could never report how many captures it
            // lost. `Wait` makes `TryWrite` return false when the buffer is full, which
            // is the same behaviour on the print path and an honest number to log.
            // (`WriteAsync` would block under this mode; the print path never calls it.)
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false,
        });

    private readonly Lock _gate = new();
    private readonly List<byte> _current = new(8 * 1024);
    private bool _overflowed;

    /// <summary>Complete print jobs, in order. Consumed off the print path.</summary>
    public ChannelReader<byte[]> Jobs => _jobs.Reader;

    /// <summary>Jobs discarded because the consumer was not keeping up.</summary>
    public long DroppedJobs { get; private set; }

    /// <inheritdoc />
    public void TryCapture(ReadOnlySpan<byte> bytes)
    {
        try
        {
            lock (_gate)
            {
                if (_current.Count + bytes.Length > MaxJobBytes)
                {
                    _overflowed = true;
                    return;
                }

                _current.AddRange(bytes);
            }
        }
        catch
        {
            // Out of memory, or anything else: the print path never learns about it.
        }
    }

    /// <inheritdoc />
    public void TryCompleteJob()
    {
        try
        {
            byte[] job;
            lock (_gate)
            {
                if (_current.Count == 0)
                {
                    _overflowed = false;
                    return;
                }

                // An overflowed job is truncated and would parse to a wrong total or no
                // total. §4.5's rule — a doubtful amount is worse than none — applies
                // here too, so it is dropped rather than half-captured.
                if (_overflowed)
                {
                    _current.Clear();
                    _overflowed = false;
                    DroppedJobs += 1;
                    return;
                }

                job = [.. _current];
                _current.Clear();
            }

            if (!_jobs.Writer.TryWrite(job))
            {
                DroppedJobs += 1;
            }
        }
        catch
        {
            // As above.
        }
    }

    public void Dispose() => _jobs.Writer.TryComplete();
}
