using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Walaa.Agent.Delivery;

/// <summary>
/// One captured invoice, in the shape the API's ingest endpoint expects.
/// </summary>
/// <remarks>
/// The field names are the Normalized Invoice Schema's, snake_cased, because this
/// crosses the wire to a contract defined in <c>packages/shared-types</c>. It is the
/// one place in the agent where the naming follows something other than C# convention,
/// and it follows it exactly.
/// </remarks>
public sealed record CapturedInvoice
{
    [JsonPropertyName("invoice_id")]
    public required string InvoiceId { get; init; }

    [JsonPropertyName("amount_gross")]
    public required int AmountGross { get; init; }

    [JsonPropertyName("currency")]
    public string Currency { get; init; } = "IQD";

    [JsonPropertyName("branch_id")]
    public required string BranchId { get; init; }

    [JsonPropertyName("occurred_at")]
    public required string OccurredAt { get; init; }

    [JsonPropertyName("captured_at")]
    public required string CapturedAt { get; init; }

    [JsonPropertyName("capture_mode")]
    public required string CaptureMode { get; init; }

    /// <summary>
    /// Generated once, at capture, and reused on every retry.
    /// </summary>
    /// <remarks>
    /// This is the agent's half of §4.8. The server's unique constraint on
    /// (merchant, branch, invoice) is the guarantee; this key is what lets the server
    /// recognise a <em>retry</em> as the same capture rather than a second sale, so a
    /// dropped response never becomes a duplicate transaction. Regenerating it per
    /// attempt would defeat the whole mechanism.
    /// </remarks>
    [JsonPropertyName("idempotency_key")]
    public required string IdempotencyKey { get; init; }

    [JsonPropertyName("raw_text")]
    public string? RawText { get; init; }
}

/// <summary>
/// The agent's local queue of captures awaiting delivery (CLAUDE_v3.md §4, §7.2).
/// </summary>
/// <remarks>
/// <para>
/// One file per capture in a directory, written before any delivery is attempted. A
/// store's network drops, the manager machine reboots, the agent is restarted mid-day —
/// none of those may lose a sale that has already been captured, and an in-memory queue
/// loses all of them.
/// </para>
/// <para>
/// A file is deleted only when the server has confirmed the capture landed. "Confirmed"
/// includes a duplicate response: the server already has it, so keeping it queued would
/// retry forever.
/// </para>
/// </remarks>
public sealed class CaptureQueue(string directory, ILogger<CaptureQueue> logger)
{
    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public string Directory { get; } = directory;

    public void EnsureCreated() => System.IO.Directory.CreateDirectory(Directory);

    /// <summary>
    /// Writes a capture to disk. Returns the file it was written to, or <c>null</c> if
    /// the write failed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This method does not throw on an I/O failure, and that is a correctness
    /// requirement rather than a convenience</b> (CLAUDE_v3.md §4.6 rule 3, §12.15).
    /// Two callers, two different disasters, both reproduced in
    /// <c>StorageFailureTests</c> against the unguarded version:
    /// </para>
    /// <para>
    /// From <c>ExecuteAsync</c>'s startup, an escaping exception faults the hosted
    /// service before either loop runs, .NET's default
    /// <c>BackgroundServiceExceptionBehavior.StopHost</c> stops it, and the SCM restarts
    /// it into the same failure. For the three in-path capture modes that crash-loop is
    /// a repeating window in which a print job can be lost.
    /// </para>
    /// <para>
    /// From the parse loop mid-shift it is quieter and harder to find: only the parsing
    /// task faults, <c>ExecuteAsync</c> is still awaiting <c>Task.WhenAll</c> on a
    /// delivery loop that never ends, so the host never notices. The service stays up,
    /// reports healthy, keeps forwarding print jobs — and captures nothing ever again.
    /// </para>
    /// <para>
    /// The capture itself is genuinely lost when this returns null: there is nowhere to
    /// put it. It is lost as a log line carrying the invoice number and the amount,
    /// because the paper receipt is still in the cashier's hand and that line is what
    /// makes the sale re-enterable by a human.
    /// </para>
    /// </remarks>
    public async Task<string?> EnqueueAsync(CapturedInvoice invoice, CancellationToken cancellationToken)
    {
        // The idempotency key names the file, so re-enqueueing the same capture — a
        // spool file seen twice, say — overwrites rather than duplicates.
        var path = Path.Combine(Directory, $"{invoice.IdempotencyKey}.json");

        // Written to a temporary name and moved into place: a half-written file that a
        // crash left behind would be parsed on restart as a corrupt capture, and this
        // agent's whole job is not losing sales quietly.
        var temporary = path + ".tmp";

        try
        {
            EnsureCreated();

            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(invoice, Json), cancellationToken)
                .ConfigureAwait(false);
            File.Move(temporary, path, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Cancellation is deliberately NOT caught: it is the shutdown path, and the
            // parse loop already treats it as an orderly stop rather than a failure.
            logger.LogError(
                error,
                "could not queue invoice {InvoiceId} ({Amount} IQD) — capture lost. Check free space on {Directory}",
                invoice.InvoiceId,
                invoice.AmountGross,
                Directory);

            // A partial temporary file is the last thing an already-full volume needs,
            // and `Pending()` only reads `*.json` so leaving one would be invisible
            // rather than harmless. Best-effort by necessity — the disk that just
            // refused a write may refuse this too.
            try
            {
                File.Delete(temporary);
            }
            catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException)
            {
                logger.LogWarning(cleanup, "could not remove the partial capture {File}", temporary);
            }

            return null;
        }

        logger.LogInformation("queued invoice {InvoiceId} ({Amount} IQD)", invoice.InvoiceId, invoice.AmountGross);
        return path;
    }

    /// <summary>Everything waiting, oldest first.</summary>
    public IEnumerable<(string Path, CapturedInvoice Invoice)> Pending()
    {
        if (!System.IO.Directory.Exists(Directory))
        {
            yield break;
        }

        var files = System.IO.Directory.GetFiles(Directory, "*.json")
            .OrderBy(File.GetCreationTimeUtc)
            .ToArray();

        foreach (var file in files)
        {
            CapturedInvoice? invoice = null;
            try
            {
                invoice = JsonSerializer.Deserialize<CapturedInvoice>(File.ReadAllText(file), Json);
            }
            catch (Exception error) when (error is JsonException or IOException)
            {
                logger.LogError(error, "queued capture {File} is unreadable; leaving it in place", file);
            }

            if (invoice is not null)
            {
                yield return (file, invoice);
            }
        }
    }

    /// <summary>Removes a capture the server has confirmed.</summary>
    public void Settle(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException error)
        {
            // Left behind, it would be re-sent — which the idempotency key makes
            // harmless, so this is a log line rather than a problem.
            logger.LogWarning(error, "could not remove settled capture {File}", path);
        }
    }

    /// <summary>
    /// Moves a capture the server refused into <c>rejected/</c>.
    /// </summary>
    /// <remarks>
    /// Not deleted. A rejected capture is a sale that happened, and the reason for the
    /// rejection is usually a fixable mismatch between agent and server — so the bytes
    /// are kept where a human can find them and a corrected agent can replay them.
    /// Leaving it in the main queue instead would block every later capture behind it.
    /// </remarks>
    public void Quarantine(string path, string reason)
    {
        try
        {
            var rejected = Path.Combine(Directory, "rejected");
            System.IO.Directory.CreateDirectory(rejected);
            File.Move(path, Path.Combine(rejected, Path.GetFileName(path)), overwrite: true);
            logger.LogError("capture {File} set aside: {Reason}", Path.GetFileName(path), reason);
        }
        catch (IOException error)
        {
            logger.LogError(error, "could not set aside rejected capture {File}", path);
        }
    }

    public int Count() => System.IO.Directory.Exists(Directory)
        ? System.IO.Directory.GetFiles(Directory, "*.json").Length
        : 0;
}
