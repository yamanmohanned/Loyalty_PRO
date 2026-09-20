namespace Walaa.Agent.Capture;

/// <summary>
/// How the agent gets between the POS and the printer (docs/legacy/CLAUDE_v3.md §4.2).
/// </summary>
/// <remarks>
/// Four implementations, because the agent must work regardless of how Al-Bayan
/// prints, and which one applies is a property of the store rather than a choice.
/// </remarks>
public enum CaptureMode
{
    /// <summary>
    /// Watch the Windows spool directory for RAW print jobs.
    /// </summary>
    /// <remarks>
    /// <b>The preferred mode</b> (§4.6 rule 1), and the reason is not convenience: it is
    /// the only one that is genuinely out of the print path. It observes; it cannot
    /// block, delay, or lose a print job, and it can die without the printer noticing.
    /// Auto-detection tries it first and takes it whenever it yields data.
    /// </remarks>
    SpoolWatch,

    /// <summary>A pass-through printer that captures, then forwards to the real one.</summary>
    VirtualPrinter,

    /// <summary>A virtual COM pair; the agent reads one end and forwards to the real port.</summary>
    SerialBridge,

    /// <summary>Listen on 9100, forward to the network printer's real address.</summary>
    NetworkProxy,
}

/// <summary>Whether a mode sits in the print path, and therefore what it risks.</summary>
public static class CaptureModeFacts
{
    /// <summary>
    /// True when the printer cannot receive the job unless the agent forwards it.
    /// </summary>
    /// <remarks>
    /// §4.6 corrected the original spec here, and the correction matters: three of the
    /// four modes are in-path, and for those "the pass-through survives agent failure"
    /// was a false guarantee. If the process is not running there is no code to forward
    /// with. What the agent can honestly promise is forward-first ordering, a watchdog,
    /// and a documented one-step manual revert.
    /// </remarks>
    public static bool IsInPath(this CaptureMode mode) => mode is not CaptureMode.SpoolWatch;

    /// <summary>Arabic label for the manager's Print Capture settings screen.</summary>
    public static string Label(this CaptureMode mode) => mode switch
    {
        CaptureMode.SpoolWatch => "مراقبة قائمة الطباعة",
        CaptureMode.VirtualPrinter => "طابعة وسيطة",
        CaptureMode.SerialBridge => "جسر منفذ تسلسلي",
        CaptureMode.NetworkProxy => "وسيط طابعة شبكية",
        _ => mode.ToString(),
    };
}

/// <summary>One way of capturing print jobs.</summary>
public interface ICaptureMode : IAsyncDisposable
{
    CaptureMode Mode { get; }

    /// <summary>
    /// Starts capturing into <paramref name="sink"/>.
    /// </summary>
    /// <remarks>
    /// Must return once capture is running, not when it stops. An implementation that
    /// blocks here would stall the host's startup and, for the in-path modes, the
    /// store's printing along with it.
    /// </remarks>
    Task StartAsync(ICaptureSink sink, CancellationToken cancellationToken);

    /// <summary>
    /// Can this mode work on this machine, right now?
    /// </summary>
    /// <remarks>
    /// Used by auto-detection (§4.3). A mode reports what it can determine without side
    /// effects — the spool directory exists and is readable, the COM port is present,
    /// the listening port is free. It does not report whether data will actually arrive;
    /// only a real print job answers that.
    /// </remarks>
    Task<ProbeResult> ProbeAsync(CancellationToken cancellationToken);
}

/// <param name="Available">Whether the mode could be started here.</param>
/// <param name="Detail">Arabic explanation, shown by the settings screen either way.</param>
public readonly record struct ProbeResult(bool Available, string Detail)
{
    public static ProbeResult Yes(string detail) => new(true, detail);

    public static ProbeResult No(string detail) => new(false, detail);
}
