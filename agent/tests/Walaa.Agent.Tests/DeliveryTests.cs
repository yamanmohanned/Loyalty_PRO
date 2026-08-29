using Microsoft.Extensions.Logging.Abstractions;
using Walaa.Agent.Delivery;
using Xunit;

namespace Walaa.Agent.Tests;

/// <summary>
/// The local queue and idempotent delivery (CLAUDE_v3.md §4.8, §7.2).
/// </summary>
public class DeliveryTests : IDisposable
{
    private readonly string _directory = Directory.CreateTempSubdirectory("walaa-queue-").FullName;

    private CaptureQueue Queue() => new(_directory, NullLogger<CaptureQueue>.Instance);

    private static CapturedInvoice Invoice(string invoiceId, string? key = null) => new()
    {
        InvoiceId = invoiceId,
        AmountGross = 85_000,
        BranchId = "BAG-01",
        OccurredAt = DateTimeOffset.UtcNow.ToString("O"),
        CapturedAt = DateTimeOffset.UtcNow.ToString("O"),
        CaptureMode = "SPOOL_WATCH",
        IdempotencyKey = key ?? Guid.NewGuid().ToString(),
    };

    [Fact]
    public async Task ACaptureSurvivesARestart()
    {
        // The queue exists for the times the manager machine is unreachable, and those
        // are exactly the times a cashier PC gets rebooted. In-memory would lose the
        // sale; this must not.
        await Queue().EnqueueAsync(Invoice("INV-9824"), CancellationToken.None);

        var afterRestart = Queue();

        var pending = afterRestart.Pending().ToList();
        Assert.Single(pending);
        Assert.Equal("INV-9824", pending[0].Invoice.InvoiceId);
        Assert.Equal(85_000, pending[0].Invoice.AmountGross);
    }

    [Fact]
    public async Task ReEnqueueingTheSameCaptureDoesNotDuplicateIt()
    {
        // A spool file observed twice, or a job re-read after a restart. The idempotency
        // key names the file, so the second write replaces the first.
        var invoice = Invoice("INV-9824", key: "11111111-1111-4111-8111-111111111111");

        var queue = Queue();
        await queue.EnqueueAsync(invoice, CancellationToken.None);
        await queue.EnqueueAsync(invoice, CancellationToken.None);

        Assert.Equal(1, queue.Count());
    }

    [Fact]
    public async Task TwoDifferentSalesAreBothKept()
    {
        var queue = Queue();
        await queue.EnqueueAsync(Invoice("INV-1"), CancellationToken.None);
        await queue.EnqueueAsync(Invoice("INV-2"), CancellationToken.None);

        Assert.Equal(2, queue.Count());
    }

    [Fact]
    public async Task SettlingRemovesOnlyTheSettledCapture()
    {
        var queue = Queue();
        await queue.EnqueueAsync(Invoice("INV-1"), CancellationToken.None);
        await queue.EnqueueAsync(Invoice("INV-2"), CancellationToken.None);

        var first = queue.Pending().First();
        queue.Settle(first.Path);

        var remaining = queue.Pending().ToList();
        Assert.Single(remaining);
        Assert.NotEqual(first.Invoice.InvoiceId, remaining[0].Invoice.InvoiceId);
    }

    [Fact]
    public async Task TheIdempotencyKeyIsStableAcrossRetries()
    {
        // §4.8's whole mechanism. The key is generated once at capture; every retry
        // carries the same one, which is what lets the server recognise a redelivery
        // rather than record a second sale.
        var invoice = Invoice("INV-9824");
        var queue = Queue();
        await queue.EnqueueAsync(invoice, CancellationToken.None);

        var firstRead = queue.Pending().Single().Invoice;
        var secondRead = queue.Pending().Single().Invoice;

        Assert.Equal(invoice.IdempotencyKey, firstRead.IdempotencyKey);
        Assert.Equal(firstRead.IdempotencyKey, secondRead.IdempotencyKey);
    }

    [Fact]
    public async Task ReceiptTextIsNotStoredUnlessAskedFor()
    {
        // Receipt content, retained only with diagnostics on (§4.5).
        var queue = Queue();
        await queue.EnqueueAsync(Invoice("INV-9824") with { RawText = null }, CancellationToken.None);

        var file = Directory.GetFiles(_directory, "*.json").Single();
        var json = await File.ReadAllTextAsync(file);

        Assert.DoesNotContain("raw_text", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AHalfWrittenFileIsNeverExposedAsACapture()
    {
        // Written to a temporary name and moved into place, so a crash mid-write leaves
        // a `.tmp` rather than a truncated capture the next start would try to parse.
        var queue = Queue();
        await queue.EnqueueAsync(Invoice("INV-9824"), CancellationToken.None);
        await File.WriteAllTextAsync(Path.Combine(_directory, "torn.json.tmp"), "{\"invoice_id\":");

        Assert.Single(queue.Pending());
        Assert.Equal(1, queue.Count());
    }

    [Fact]
    public async Task AnUnreadableCaptureIsLeftInPlaceRatherThanDropped()
    {
        // Deleting it would silently lose a sale. Leaving it means a human can look.
        var queue = Queue();
        await queue.EnqueueAsync(Invoice("INV-9824"), CancellationToken.None);
        await File.WriteAllTextAsync(Path.Combine(_directory, "corrupt.json"), "not json at all");

        Assert.Single(queue.Pending());
        Assert.Equal(2, queue.Count());
        Assert.True(File.Exists(Path.Combine(_directory, "corrupt.json")));
    }

    [Fact]
    public async Task TheWireShapeIsTheNormalizedInvoiceSchema()
    {
        // The contract is defined in packages/shared-types; this is the one place the
        // agent has to match it exactly, so the field names are asserted rather than
        // assumed.
        var queue = Queue();
        await queue.EnqueueAsync(Invoice("INV-9824") with { RawText = "receipt" }, CancellationToken.None);

        var json = await File.ReadAllTextAsync(Directory.GetFiles(_directory, "*.json").Single());

        foreach (var field in new[]
        {
            "invoice_id", "amount_gross", "currency", "branch_id",
            "occurred_at", "captured_at", "capture_mode", "idempotency_key", "raw_text",
        })
        {
            Assert.Contains($"\"{field}\"", json, StringComparison.Ordinal);
        }
    }

    public void Dispose()
    {
        GC.SuppressFinalize(this);
        try
        {
            Directory.Delete(_directory, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
