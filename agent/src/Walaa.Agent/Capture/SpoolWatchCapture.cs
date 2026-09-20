using Microsoft.Extensions.Logging;

namespace Walaa.Agent.Capture;

/// <summary>
/// Watches the Windows spool directory for RAW print jobs (docs/legacy/CLAUDE_v3.md §4.2).
/// </summary>
/// <remarks>
/// <para>
/// <b>This is the mode to prefer, and the only one that is safe by construction.</b> It
/// reads files the spooler has already written; it is not between the POS and the
/// printer and cannot become so. Kill this process mid-receipt and the receipt still
/// prints — which is precisely what §4.6 rule 1 asks auto-detection to prioritise.
/// </para>
/// <para>
/// The awkwardness it trades for that safety is real, and worth stating: a spool file
/// is written incrementally and deleted as soon as the job finishes printing, so the
/// agent is reading a file that is being written and may vanish. Both are handled below
/// — the file is read after it stops growing, and a disappearing file is an expected
/// outcome rather than an error.
/// </para>
/// </remarks>
public sealed class SpoolWatchCapture(
    string spoolDirectory,
    ILogger<SpoolWatchCapture> logger,
    TimeSpan? settleTime = null) : ICaptureMode
{
    /// <summary>The Windows spooler's RAW job directory.</summary>
    public static string DefaultSpoolDirectory =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "spool",
            "PRINTERS");

    /// <summary>
    /// How long a spool file must stop changing before it is read.
    /// </summary>
    /// <remarks>
    /// A job is written in chunks. Reading on the first change event yields half a
    /// receipt, which parses to a wrong total or none — and §4.5's rule is that a
    /// doubtful amount is worse than no amount.
    /// </remarks>
    private readonly TimeSpan _settleTime = settleTime ?? TimeSpan.FromMilliseconds(700);

    private FileSystemWatcher? _watcher;
    private CancellationTokenSource? _stopping;
    private readonly HashSet<string> _seen = [];
    private readonly Lock _seenGate = new();

    public CaptureMode Mode => CaptureMode.SpoolWatch;

    public Task<ProbeResult> ProbeAsync(CancellationToken cancellationToken)
    {
        if (!Directory.Exists(spoolDirectory))
        {
            return Task.FromResult(ProbeResult.No($"مجلد قائمة الطباعة غير موجود: {spoolDirectory}"));
        }

        try
        {
            // Enumerating is the real test: the directory exists for everyone, but
            // reading it needs privilege the service account may not have.
            _ = Directory.EnumerateFiles(spoolDirectory, "*.SPL").Take(1).Count();
            return Task.FromResult(ProbeResult.Yes($"يمكن قراءة مجلد قائمة الطباعة: {spoolDirectory}"));
        }
        catch (UnauthorizedAccessException)
        {
            return Task.FromResult(ProbeResult.No("لا توجد صلاحية لقراءة مجلد قائمة الطباعة"));
        }
        catch (IOException error)
        {
            return Task.FromResult(ProbeResult.No($"تعذّر قراءة مجلد قائمة الطباعة: {error.Message}"));
        }
    }

    public Task StartAsync(ICaptureSink sink, CancellationToken cancellationToken)
    {
        _stopping = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

        _watcher = new FileSystemWatcher(spoolDirectory, "*.SPL")
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
            IncludeSubdirectories = false,
        };

        _watcher.Created += (_, e) => Observe(e.FullPath, sink);
        _watcher.Changed += (_, e) => Observe(e.FullPath, sink);
        _watcher.EnableRaisingEvents = true;

        logger.LogInformation("watching spool directory {Directory}", spoolDirectory);
        return Task.CompletedTask;
    }

    private void Observe(string path, ICaptureSink sink)
    {
        lock (_seenGate)
        {
            // Created and Changed both fire, repeatedly, for one job.
            if (!_seen.Add(path))
            {
                return;
            }
        }

        _ = Task.Run(() => ReadWhenSettledAsync(path, sink), _stopping?.Token ?? CancellationToken.None);
    }

    /// <summary>
    /// Waits for the spooler to finish writing, then reads the job.
    /// </summary>
    /// <remarks>
    /// The file may be deleted at any point — the spooler removes it the moment the
    /// printer confirms the job. That is a normal outcome here, not a failure: the
    /// receipt printed, which is what matters, and the agent simply did not get a copy.
    /// </remarks>
    private async Task ReadWhenSettledAsync(string path, ICaptureSink sink)
    {
        var token = _stopping?.Token ?? CancellationToken.None;

        try
        {
            long lastLength = -1;

            for (var attempt = 0; attempt < 40 && !token.IsCancellationRequested; attempt += 1)
            {
                if (!File.Exists(path))
                {
                    // Gone before it settled: the job printed and the spooler cleaned up.
                    return;
                }

                var length = new FileInfo(path).Length;
                if (length > 0 && length == lastLength)
                {
                    break;
                }

                lastLength = length;
                await Task.Delay(_settleTime, token).ConfigureAwait(false);
            }

            byte[] bytes;
            try
            {
                // ReadWrite share: the spooler still holds the file open.
                await using var stream = new FileStream(
                    path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var buffer = new MemoryStream();
                await stream.CopyToAsync(buffer, token).ConfigureAwait(false);
                bytes = buffer.ToArray();
            }
            catch (FileNotFoundException)
            {
                return;
            }
            catch (IOException error)
            {
                logger.LogDebug(error, "spool file {Path} could not be read", path);
                return;
            }

            if (bytes.Length == 0)
            {
                return;
            }

            sink.TryCapture(bytes);
            sink.TryCompleteJob();
            logger.LogInformation("captured {Bytes} bytes from {Path}", bytes.Length, Path.GetFileName(path));
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
        finally
        {
            lock (_seenGate)
            {
                _seen.Remove(path);
            }
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
