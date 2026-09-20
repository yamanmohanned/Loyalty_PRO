namespace Walaa.Agent.Capture;

/// <summary>
/// Where captured bytes go. Implementations must never throw and never block.
/// </summary>
/// <remarks>
/// This interface exists to make the FORWARD-FIRST rule (docs/legacy/CLAUDE_v3.md §4.6 rule 2)
/// enforceable rather than aspirational. Everything the agent does with a receipt —
/// parsing it, queueing it, sending it — happens behind this boundary, on another
/// thread, after the bytes are already on their way to the printer.
/// </remarks>
public interface ICaptureSink
{
    /// <summary>
    /// Offers bytes for capture. Returns immediately; drops rather than waits.
    /// </summary>
    /// <remarks>
    /// A sink that is slow, broken, or full must cost the print path nothing. Losing a
    /// capture means one customer's purchase is not credited; blocking the print path
    /// means the shop cannot sell anything. The trade is not close.
    /// </remarks>
    void TryCapture(ReadOnlySpan<byte> bytes);

    /// <summary>Marks the end of one print job. Also non-blocking, also never throws.</summary>
    void TryCompleteJob();
}

/// <summary>
/// The forwarding loop shared by the three in-path capture modes
/// (<c>VIRTUAL_PRINTER</c>, <c>SERIAL_BRIDGE</c>, <c>NETWORK_PROXY</c>).
/// </summary>
/// <remarks>
/// <para>
/// <b>This is the code that decides whether a shop can print.</b> §4.6 states the rule
/// plainly: bytes go to the real printer or port <em>before</em> any capture, parsing,
/// queueing, or network work, and the forwarding path is minimal and dependency-free.
/// </para>
/// <para>
/// So the loop below reads, writes, flushes, and only then offers the bytes to a sink
/// that is contractually unable to throw or block. There is no allocation inside the
/// loop, no logging on the hot path, and no <c>await</c> on anything but the source and
/// the destination. A parsing bug, a full disk, or a dead manager machine cannot reach
/// it.
/// </para>
/// <para>
/// The honest limit, restated from §4.6: this does not survive the agent process
/// dying. Nothing in-path can. That is why <c>SPOOL_WATCH</c> is preferred, why a
/// watchdog restarts the service, and why the setup guide documents a one-step manual
/// revert.
/// </para>
/// </remarks>
public static class PrintRelay
{
    /// <summary>
    /// A thermal receipt is a few kilobytes; this holds a whole one in most cases and
    /// bounds the copy per iteration in all of them.
    /// </summary>
    private const int BufferSize = 8 * 1024;

    /// <summary>
    /// Copies <paramref name="source"/> to <paramref name="destination"/>, offering
    /// each chunk to <paramref name="sink"/> only after it has been forwarded.
    /// </summary>
    /// <returns>The number of bytes forwarded.</returns>
    public static async Task<long> RelayAsync(
        Stream source,
        Stream destination,
        ICaptureSink sink,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[BufferSize];
        long forwarded = 0;

        while (!cancellationToken.IsCancellationRequested)
        {
            int read;
            try
            {
                read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            if (read == 0)
            {
                break;
            }

            // ── FORWARD FIRST (§4.6 rule 2) ──────────────────────────────────────
            // Nothing may be inserted above this write. Not a parse, not a log, not a
            // metric. The receipt is on its way before the agent takes any interest in
            // what it says.
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
            await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
            forwarded += read;

            // ── Then, and only then, capture ─────────────────────────────────────
            // `TryCapture` cannot throw by contract, and the guard below is the belt to
            // that contract's braces: an implementation that violates it must still not
            // stop the printing.
            try
            {
                sink.TryCapture(buffer.AsSpan(0, read));
            }
            catch
            {
                // Deliberately swallowed. See the class remarks.
            }
        }

        try
        {
            sink.TryCompleteJob();
        }
        catch
        {
            // As above.
        }

        return forwarded;
    }
}
