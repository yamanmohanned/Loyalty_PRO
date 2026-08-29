using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;

namespace Walaa.Agent.Capture;

/// <summary>
/// A pass-through printer: captures the job, then forwards it to the real printer
/// (CLAUDE_v3.md §4.2).
/// </summary>
/// <remarks>
/// <para>
/// Al-Bayan is pointed at a Windows printer whose port writes to a folder. The agent
/// watches that folder, sends each job on to the real printer through the spooler's RAW
/// datatype, and keeps a copy. More reliable than <c>SPOOL_WATCH</c> because the job is
/// addressed to the agent rather than observed in passing — and less safe, because the
/// receipt now depends on the agent to arrive at all.
/// </para>
/// <para>
/// <b>Forward-first still applies (§4.6 rule 2), and looks different here.</b> The job
/// is whole before the agent sees it, so there is no byte-by-byte race — but the
/// ordering is still forwarding first, parsing never: this class sends to the printer
/// and hands the bytes to the sink, and nothing between those two steps can inspect,
/// decode, or queue anything.
/// </para>
/// </remarks>
public sealed class VirtualPrinterCapture(
    string dropDirectory,
    string realPrinterName,
    ILogger<VirtualPrinterCapture> logger) : ICaptureMode
{
    private FileSystemWatcher? _watcher;
    private CancellationTokenSource? _stopping;

    public CaptureMode Mode => CaptureMode.VirtualPrinter;

    public Task<ProbeResult> ProbeAsync(CancellationToken cancellationToken)
    {
        if (!Directory.Exists(dropDirectory))
        {
            return Task.FromResult(ProbeResult.No($"مجلد الطابعة الوسيطة غير موجود: {dropDirectory}"));
        }

        if (!RawPrinter.Exists(realPrinterName))
        {
            return Task.FromResult(ProbeResult.No($"الطابعة «{realPrinterName}» غير موجودة"));
        }

        return Task.FromResult(ProbeResult.Yes($"{dropDirectory} ← الكاشير، «{realPrinterName}» ← الطابعة"));
    }

    public Task StartAsync(ICaptureSink sink, CancellationToken cancellationToken)
    {
        _stopping = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        _watcher = new FileSystemWatcher(dropDirectory)
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.Size,
            IncludeSubdirectories = false,
        };
        _watcher.Created += (_, e) => _ = Task.Run(
            () => HandleAsync(e.FullPath, sink), _stopping.Token);
        _watcher.EnableRaisingEvents = true;

        logger.LogInformation(
            "virtual printer: {Drop} -> {Printer}", dropDirectory, realPrinterName);
        return Task.CompletedTask;
    }

    private async Task HandleAsync(string path, ICaptureSink sink)
    {
        var token = _stopping?.Token ?? CancellationToken.None;

        try
        {
            // Wait for the port monitor to finish writing the job.
            long last = -1;
            for (var i = 0; i < 40 && !token.IsCancellationRequested; i += 1)
            {
                if (!File.Exists(path))
                {
                    return;
                }

                var length = new FileInfo(path).Length;
                if (length > 0 && length == last)
                {
                    break;
                }

                last = length;
                await Task.Delay(TimeSpan.FromMilliseconds(400), token).ConfigureAwait(false);
            }

            var bytes = await File.ReadAllBytesAsync(path, token).ConfigureAwait(false);
            if (bytes.Length == 0)
            {
                return;
            }

            // ── FORWARD FIRST ────────────────────────────────────────────────────
            RawPrinter.Send(realPrinterName, bytes, logger);

            sink.TryCapture(bytes);
            sink.TryCompleteJob();

            // Only once it has printed. A job left behind would be re-sent on restart
            // and print the customer a second receipt.
            TryDelete(path);
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException error)
        {
            logger.LogError(error, "virtual printer job {Path} failed", path);
        }
    }

    private void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException error)
        {
            logger.LogWarning(error, "could not remove spooled job {Path}", path);
        }
    }

    public ValueTask DisposeAsync()
    {
        _watcher?.Dispose();
        _stopping?.Cancel();
        _stopping?.Dispose();
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// Sends bytes to a Windows printer as a RAW job.
/// </summary>
/// <remarks>
/// RAW because the payload is already ESC/POS: the bytes the POS produced are exactly
/// the bytes the printer must receive, and letting a driver render them would change
/// the receipt the customer is handed.
/// </remarks>
internal static class RawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DocInfo
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string DocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? OutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
    }

    // Classic DllImport, not the source-generated LibraryImport. The generator requires
    // `AllowUnsafeBlocks` across the whole project, and this assembly sits in a shop's
    // print path — widening the language's safety guarantees to save six attributes is
    // the wrong trade. DllImport also marshals the DOCINFO struct, which the generator
    // declines to.
    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenPrinter(string printerName, out IntPtr handle, IntPtr defaults);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClosePrinter(IntPtr handle);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int StartDocPrinter(IntPtr handle, int level, [In] ref DocInfo info);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndDocPrinter(IntPtr handle);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartPagePrinter(IntPtr handle);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndPagePrinter(IntPtr handle);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WritePrinter(IntPtr handle, IntPtr bytes, int count, out int written);

    /// <summary>True when Windows knows a printer by this name.</summary>
    public static bool Exists(string printerName)
    {
        if (!OpenPrinter(printerName, out var handle, IntPtr.Zero))
        {
            return false;
        }

        ClosePrinter(handle);
        return true;
    }

    /// <summary>Sends one RAW job. Throws nothing the caller has to handle mid-print.</summary>
    public static void Send(string printerName, byte[] bytes, ILogger logger)
    {
        if (!OpenPrinter(printerName, out var handle, IntPtr.Zero))
        {
            logger.LogError(
                "cannot open printer {Printer} (win32 {Error})",
                printerName,
                Marshal.GetLastWin32Error());
            return;
        }

        var unmanaged = IntPtr.Zero;
        try
        {
            var info = new DocInfo
            {
                DocName = "Walaa capture pass-through",
                OutputFile = null,
                DataType = "RAW",
            };

            if (StartDocPrinter(handle, 1, ref info) == 0)
            {
                logger.LogError("StartDocPrinter failed for {Printer}", printerName);
                return;
            }

            if (!StartPagePrinter(handle))
            {
                logger.LogError("StartPagePrinter failed for {Printer}", printerName);
                EndDocPrinter(handle);
                return;
            }

            unmanaged = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, unmanaged, bytes.Length);

            if (!WritePrinter(handle, unmanaged, bytes.Length, out var written) || written != bytes.Length)
            {
                logger.LogError(
                    "WritePrinter wrote {Written} of {Total} bytes to {Printer}",
                    written,
                    bytes.Length,
                    printerName);
            }

            EndPagePrinter(handle);
            EndDocPrinter(handle);
        }
        finally
        {
            if (unmanaged != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(unmanaged);
            }

            ClosePrinter(handle);
        }
    }
}
