using Microsoft.Extensions.Logging.Abstractions;
using Walaa.Agent.Capture;
using Walaa.Agent.Delivery;
using Walaa.Agent.Parsing;
using Xunit;

namespace Walaa.Agent.Tests;

/// <summary>
/// A full disk must not breach Fail-Open (docs/legacy/CLAUDE_v3.md §4.6 rule 3, §12.15).
/// </summary>
/// <remarks>
/// <para>
/// <see cref="ForwardFirstTests"/> proves the receipt still reaches the printer when the
/// capture side throws, hangs or runs out of memory. This suite covers the route that
/// class of test missed: the capture side failing on <b>storage</b>, where the exception
/// never surfaces on the print path at all. Before the fix these tests pin, an
/// unwritable queue produced <b>two different failures depending on when it happened</b>,
/// and both were reproduced by running this suite against the unfixed code:
/// </para>
/// <list type="number">
///   <item>
///     <b>At startup</b> — <c>EnsureCreated</c> ran before either loop and outside any
///     handler, so the exception faulted <c>ExecuteAsync</c> directly. .NET's default
///     <c>BackgroundServiceExceptionBehavior.StopHost</c> then stops the service, the
///     SCM's immediate-restart policy starts it again, and it fails again. For the three
///     in-path capture modes that crash-loop is a repeating window in which a print job
///     can be lost — the §4.6 rule 3 breach, reached through a back door nobody was
///     watching.
///   </item>
///   <item>
///     <b>Mid-shift</b> — the throw came from <c>EnqueueAsync</c> inside the parse loop,
///     which faulted only the parsing task. <c>ExecuteAsync</c> awaits
///     <c>Task.WhenAll(parsing, delivering)</c>, and the delivery loop never ends, so
///     <c>WhenAll</c> never completed and the host never noticed. <b>The service stayed
///     up, reported healthy, kept forwarding print jobs, and captured nothing ever
///     again.</b> No crash, no restart, no event-log entry — silent until someone
///     rebooted the till. Milder than (1) for printing and worse than it for detection.
///   </item>
/// </list>
/// <para>
/// <b>What is and is not reproduced here.</b> These tests do not fill a volume. They
/// raise, at the same call sites, the same exception type a full disk raises there —
/// <see cref="IOException"/> out of <c>Directory.CreateDirectory</c> and the write inside
/// <see cref="CaptureQueue.EnqueueAsync"/> — by putting a plain file where the queue
/// directory belongs. That proves the escape path and its fix. It does not prove the
/// behaviour of this code on a genuinely exhausted NTFS volume, which has not been
/// observed.
/// </para>
/// </remarks>
public class StorageFailureTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("walaa-storage-").FullName;

    private string Spool => Path.Combine(_root, "spool");

    private string QueueDirectory => Path.Combine(_root, "queue");

    public StorageFailureTests()
    {
        Directory.CreateDirectory(Spool);
        Directory.CreateDirectory(QueueDirectory);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // A file watcher may still hold a handle. The temp directory is disposable.
        }

        GC.SuppressFinalize(this);
    }

    private static CapturedInvoice Invoice(string invoiceId) => new()
    {
        InvoiceId = invoiceId,
        AmountGross = 85_000,
        BranchId = "BAG-01",
        OccurredAt = DateTimeOffset.UtcNow.ToString("O"),
        CapturedAt = DateTimeOffset.UtcNow.ToString("O"),
        CaptureMode = "SPOOL_WATCH",
        IdempotencyKey = Guid.NewGuid().ToString(),
    };

    /// <summary>
    /// Replaces the queue directory with a plain file, so every attempt to create it or
    /// write inside it raises <see cref="IOException"/> — the shape of a full disk.
    /// </summary>
    private void BlockTheQueueDirectory()
    {
        if (Directory.Exists(QueueDirectory))
        {
            Directory.Delete(QueueDirectory, recursive: true);
        }

        File.WriteAllText(QueueDirectory, "a file where a directory should be");
    }

    private void UnblockTheQueueDirectory()
    {
        if (File.Exists(QueueDirectory))
        {
            File.Delete(QueueDirectory);
        }

        Directory.CreateDirectory(QueueDirectory);
    }

    /// <summary>
    /// The §4.6 rule 3 breach itself: an unwritable queue at startup must not stop the
    /// service from starting.
    /// </summary>
    /// <remarks>
    /// This is the crash-loop path. A service that cannot start is restarted by the SCM,
    /// immediately and repeatedly by design, and each restart of an in-path capture mode
    /// is a window in which a print job can be lost. A merchant whose disk filled
    /// overnight would find the till unable to print reliably in the morning, for a
    /// reason with no connection on its face to a loyalty agent.
    /// </remarks>
    [Fact]
    public async Task AnUnwritableQueueAtStartupDoesNotStopTheService()
    {
        BlockTheQueueDirectory();

        var queue = new CaptureQueue(QueueDirectory, NullLogger<CaptureQueue>.Instance);
        using var http = new HttpClient { BaseAddress = new Uri("http://127.0.0.1:9") };

        var worker = new AgentWorker(
            new AgentSettings
            {
                Mode = CaptureMode.SpoolWatch,
                SpoolDirectory = Spool,
                QueueDirectory = QueueDirectory,
                BranchCode = "BAG-01",
                ManagerUrl = "http://127.0.0.1:9",
            },
            queue,
            new IngestClient(http, NullLogger<IngestClient>.Instance),
            NullLogger<AgentWorker>.Instance,
            NullLoggerFactory.Instance);

        // Unfixed, this throws out of StartAsync: `EnsureCreated` sat above every await
        // in `ExecuteAsync`, so the exception was raised synchronously and the host
        // never came up at all.
        await worker.StartAsync(CancellationToken.None);

        try
        {
            Assert.False(worker.ExecuteTask?.IsFaulted ?? false);
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task AnUnwritableQueueReportsTheLossInsteadOfThrowing()
    {
        BlockTheQueueDirectory();

        var queue = new CaptureQueue(QueueDirectory, NullLogger<CaptureQueue>.Instance);

        // The contract the parse loop depends on: a storage failure is a null, never an
        // exception. The capture is genuinely lost — there is nowhere to put it — but it
        // is lost as a return value a caller can handle.
        var path = await queue.EnqueueAsync(Invoice("INV-9824"), CancellationToken.None);

        Assert.Null(path);
    }

    [Fact]
    public async Task AFailedEnqueueLeavesNoPartialFileBehind()
    {
        var queue = new CaptureQueue(QueueDirectory, NullLogger<CaptureQueue>.Instance);
        await queue.EnqueueAsync(Invoice("INV-9824"), CancellationToken.None);

        // `Pending()` reads only `*.json`, so an abandoned `.tmp` would be invisible
        // rather than harmless — it would simply sit on the volume that refused the write.
        Assert.Empty(Directory.GetFiles(QueueDirectory, "*.tmp"));
    }

    /// <summary>
    /// The one that matters: the whole agent, driven end to end, surviving a storage
    /// failure mid-shift and still capturing afterwards.
    /// </summary>
    [Fact]
    public async Task TheAgentSurvivesAStorageFailureAndKeepsCapturing()
    {
        var settings = new AgentSettings
        {
            Mode = CaptureMode.SpoolWatch,
            SpoolDirectory = Spool,
            QueueDirectory = QueueDirectory,
            BranchCode = "BAG-01",
            // Deliberately unreachable. Delivery failing is not what this test is about,
            // and the delivery loop already swallows it — so nothing here can settle or
            // remove a queued capture, and the counts below mean what they say.
            ManagerUrl = "http://127.0.0.1:9",
        };

        var queue = new CaptureQueue(QueueDirectory, NullLogger<CaptureQueue>.Instance);
        using var http = new HttpClient { BaseAddress = new Uri(settings.ManagerUrl) };
        var ingest = new IngestClient(http, NullLogger<IngestClient>.Instance);

        var worker = new AgentWorker(
            settings,
            queue,
            ingest,
            NullLogger<AgentWorker>.Instance,
            NullLoggerFactory.Instance);

        await worker.StartAsync(CancellationToken.None);

        try
        {
            // 1. A healthy capture first. Without it this test could pass merely because
            //    the watcher had not started yet, and would prove nothing at all.
            Print("00010.SPL", "INV-9824");
            Assert.True(await Settles(queue, 1), "the agent never captured while healthy");

            // 2. Storage fails. The capture is genuinely lost; the service must not be.
            BlockTheQueueDirectory();
            Print("00011.SPL", "INV-9827");
            await Task.Delay(TimeSpan.FromSeconds(3));

            Assert.False(
                worker.ExecuteTask?.IsFaulted ?? false,
                "a storage failure faulted the worker — this is the §4.6 rule 3 breach");

            // 3. Space comes back. The loop has to still be running to notice.
            UnblockTheQueueDirectory();
            Print("00012.SPL", "INV-9830");
            Assert.True(await Settles(queue, 1), "the agent stopped capturing after a storage failure");

            var recovered = queue.Pending().Single();
            Assert.Equal("INV-9830", recovered.Invoice.InvoiceId);
            Assert.Equal(85_000, recovered.Invoice.AmountGross);
            Assert.False(worker.ExecuteTask?.IsFaulted ?? false);
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None);
        }
    }

    private void Print(string spoolFile, string invoiceId) =>
        File.WriteAllBytes(
            Path.Combine(Spool, spoolFile),
            ReceiptFixture.Receipt(ArabicText.Cp864, invoiceId, "85,000"));

    /// <summary>
    /// Waits for the queue to hold <paramref name="expected"/> captures.
    /// </summary>
    /// <remarks>
    /// A spool file must stop changing for 700ms before it is read (see
    /// <c>SpoolWatchCapture</c>), so this polls rather than sleeping a fixed interval.
    /// </remarks>
    private static async Task<bool> Settles(CaptureQueue queue, int expected)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            if (queue.Count() == expected)
            {
                return true;
            }

            await Task.Delay(100);
        }

        return false;
    }
}
