using Microsoft.Extensions.Logging;

namespace Walaa.Agent.Capture;

/// <summary>
/// Works out how this store prints (docs/legacy/CLAUDE_v3.md §4.3).
/// </summary>
/// <remarks>
/// <para>
/// Run at install: try each mode, report which produces data, persist the winner, allow
/// a manual override. What turns that from a list into a rule is §4.6:
/// </para>
/// <para>
/// <b>SPOOL_WATCH is tried first and wins whenever it yields data</b> — not because it
/// is the most reliable capture (it is not; a job can be gone before it settles) but
/// because it is the only mode that is out of the print path. Every other mode buys
/// better capture with the risk that a dead agent means a shop that cannot print. That
/// trade is only worth making when passive observation produces nothing at all.
/// </para>
/// </remarks>
public sealed class CaptureDetector(ILogger<CaptureDetector> logger)
{
    /// <param name="Mode">The mode under test.</param>
    /// <param name="Probe">Whether it could run here at all.</param>
    /// <param name="JobsSeen">How many print jobs it actually captured during the window.</param>
    /// <param name="BytesSeen">How many bytes those jobs carried.</param>
    public readonly record struct ModeReport(
        CaptureMode Mode,
        ProbeResult Probe,
        int JobsSeen,
        long BytesSeen)
    {
        /// <summary>A mode "yields data" when a real print job arrived through it.</summary>
        public bool YieldedData => JobsSeen > 0 && BytesSeen > 0;
    }

    /// <param name="Selected">The mode to persist, or null when nothing produced data.</param>
    /// <param name="Reports">Every mode's result, for the manager's capture screen.</param>
    /// <param name="Reason">Arabic explanation of the choice.</param>
    public readonly record struct DetectionResult(
        CaptureMode? Selected,
        IReadOnlyList<ModeReport> Reports,
        string Reason);

    /// <summary>
    /// Runs each candidate for <paramref name="window"/> and picks a winner.
    /// </summary>
    /// <remarks>
    /// The caller is expected to print test receipts during the window — detection
    /// cannot manufacture a print job, and a mode that sees nothing has not been proven
    /// unusable, only unexercised. That distinction is in the report so the settings
    /// screen can say "no receipt was printed" rather than "this mode does not work".
    /// </remarks>
    public async Task<DetectionResult> DetectAsync(
        IReadOnlyList<ICaptureMode> candidates,
        TimeSpan window,
        CancellationToken cancellationToken)
    {
        var reports = new List<ModeReport>();

        // Ordered, not sorted by result: SPOOL_WATCH is evaluated first so that a store
        // where it works never even considers an in-path mode.
        foreach (var mode in candidates.OrderBy(c => (int)c.Mode))
        {
            var report = await MeasureAsync(mode, window, cancellationToken).ConfigureAwait(false);
            reports.Add(report);

            if (report.Mode == CaptureMode.SpoolWatch && report.YieldedData)
            {
                logger.LogInformation("spool watching produced data; stopping detection here");
                return new DetectionResult(
                    CaptureMode.SpoolWatch,
                    reports,
                    "تم اختيار مراقبة قائمة الطباعة لأنها لا تعترض مسار الطباعة إطلاقاً");
            }
        }

        var winner = reports.FirstOrDefault(r => r.YieldedData);
        if (winner.YieldedData)
        {
            return new DetectionResult(
                winner.Mode,
                reports,
                $"تم اختيار «{winner.Mode.Label()}» لأنه الوضع الوحيد الذي التقط بيانات فعلية");
        }

        return new DetectionResult(
            null,
            reports,
            "لم يلتقط أي وضع بيانات — تأكد من طباعة فاتورة تجريبية أثناء الفحص");
    }

    private async Task<ModeReport> MeasureAsync(
        ICaptureMode mode,
        TimeSpan window,
        CancellationToken cancellationToken)
    {
        var probe = await mode.ProbeAsync(cancellationToken).ConfigureAwait(false);
        logger.LogInformation(
            "probe {Mode}: available={Available} — {Detail}", mode.Mode, probe.Available, probe.Detail);

        if (!probe.Available)
        {
            return new ModeReport(mode.Mode, probe, 0, 0);
        }

        var counting = new CountingSink();
        using var modeLifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        try
        {
            await mode.StartAsync(counting, modeLifetime.Token).ConfigureAwait(false);
            await Task.Delay(window, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception error)
        {
            // A mode that cannot start is a mode that does not work here — worth
            // reporting, never worth aborting the detection of the others.
            logger.LogWarning(error, "mode {Mode} failed to start", mode.Mode);
            return new ModeReport(mode.Mode, ProbeResult.No(error.Message), 0, 0);
        }
        finally
        {
            await modeLifetime.CancelAsync().ConfigureAwait(false);
            await mode.DisposeAsync().ConfigureAwait(false);
        }

        return new ModeReport(mode.Mode, probe, counting.Jobs, counting.Bytes);
    }

    /// <summary>Counts what arrived, and keeps nothing. Detection needs a number, not the receipt.</summary>
    private sealed class CountingSink : ICaptureSink
    {
        private long _bytes;
        private int _jobs;
        private bool _any;

        public int Jobs => _jobs;

        public long Bytes => Interlocked.Read(ref _bytes);

        public void TryCapture(ReadOnlySpan<byte> bytes)
        {
            Interlocked.Add(ref _bytes, bytes.Length);
            _any = true;
        }

        public void TryCompleteJob()
        {
            if (_any)
            {
                Interlocked.Increment(ref _jobs);
                _any = false;
            }
        }
    }
}
