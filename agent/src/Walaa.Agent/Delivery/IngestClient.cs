using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Walaa.Agent.Delivery;

/// <summary>
/// Delivers captures to the Manager machine's API (CLAUDE_v3.md §4, §4.8).
/// </summary>
/// <remarks>
/// <para>
/// The agent authenticates like any other client and posts the Normalized Invoice
/// Schema. Its internal language is irrelevant to the rest of the system (§3) — this is
/// the only surface where the C# ends and the contract begins.
/// </para>
/// <para>
/// <b>Idempotency (§4.8) is a three-part arrangement</b>, and all three parts have to
/// hold: the capture carries a key generated once and reused on every retry; the server
/// enforces a unique constraint on (merchant, branch, invoice); and a duplicate answer
/// is treated here as success. Miss the last one and the agent retries forever against
/// a server that is telling it, correctly, that the work is already done.
/// </para>
/// </remarks>
public sealed class IngestClient(HttpClient http, ILogger<IngestClient> logger)
{
    private string? _accessToken;

    /// <summary>
    /// Omits null properties.
    /// </summary>
    /// <remarks>
    /// The Normalized Invoice Schema declares `raw_text` OPTIONAL, not nullable, so a
    /// payload carrying `"raw_text": null` is rejected outright — which is how this was
    /// found: every capture with diagnostics off failed validation. The queue file
    /// already omitted nulls; the wire payload did not, because `JsonContent.Create`
    /// uses web defaults rather than the queue's options.
    /// </remarks>
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private sealed record LoginRequest(string Username, string Password);

    private sealed record Tokens(
        [property: JsonPropertyName("accessToken")] string AccessToken,
        [property: JsonPropertyName("refreshToken")] string RefreshToken);

    private sealed record LoginResponse([property: JsonPropertyName("tokens")] Tokens Tokens);

    private sealed record IngestRequest(
        [property: JsonPropertyName("agentId")] string AgentId,
        [property: JsonPropertyName("invoice")] CapturedInvoice Invoice);

    /// <param name="Settled">
    /// True when the capture may be removed from the queue — including when the server
    /// says it already has it.
    /// </param>
    /// <param name="Duplicate">True when the server had already recorded this capture.</param>
    /// <param name="Retryable">True when the same request is worth sending again later.</param>
    public readonly record struct DeliveryResult(bool Settled, bool Duplicate, bool Retryable, string Detail);

    public async Task<bool> SignInAsync(string username, string password, CancellationToken cancellationToken)
    {
        try
        {
            var response = await http
                .PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(username, password), cancellationToken)
                .ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                logger.LogError("agent sign-in failed: {Status}", response.StatusCode);
                return false;
            }

            var body = await response.Content
                .ReadFromJsonAsync<LoginResponse>(cancellationToken)
                .ConfigureAwait(false);

            _accessToken = body?.Tokens.AccessToken;
            return _accessToken is not null;
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            logger.LogWarning(error, "agent sign-in could not reach the manager machine");
            return false;
        }
    }

    /// <summary>Posts one capture.</summary>
    public async Task<DeliveryResult> DeliverAsync(
        string agentId,
        CapturedInvoice invoice,
        CancellationToken cancellationToken)
    {
        if (_accessToken is null)
        {
            return new DeliveryResult(false, false, true, "not signed in");
        }

        HttpResponseMessage response;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/ingest/invoice")
            {
                Content = JsonContent.Create(new IngestRequest(agentId, invoice), options: Wire),
            };
            request.Headers.Authorization = new("Bearer", _accessToken);

            response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            // The manager machine is unreachable. The capture stays queued; that is what
            // the queue is for.
            return new DeliveryResult(false, false, true, error.Message);
        }

        using (response)
        {
            switch (response.StatusCode)
            {
                case HttpStatusCode.Created:
                    return new DeliveryResult(true, false, false, "recorded");

                case HttpStatusCode.OK:
                    // The server already had it — a retry after a dropped response. From
                    // the agent's side the job was to make sure the capture landed, and
                    // it has.
                    return new DeliveryResult(true, true, false, "already recorded");

                case HttpStatusCode.Unauthorized:
                    // The short-lived access token expired. Sign in again on the next
                    // pass rather than dropping a real capture.
                    _accessToken = null;
                    return new DeliveryResult(false, false, true, "token expired");

                case HttpStatusCode.BadRequest:
                case HttpStatusCode.UnprocessableEntity:
                {
                    // The server rejected the content itself, so retrying cannot help and
                    // retrying forever would bury every later capture behind this one.
                    //
                    // But it must not be DELETED either. This path was found by an
                    // integration run in which a schema mismatch made the server reject
                    // every capture — and the agent, treating rejection as settled,
                    // deleted two real sales. Rejected captures are set aside instead,
                    // where a human can see them and a fixed agent can replay them.
                    var detail = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                    logger.LogError(
                        "invoice {InvoiceId} rejected by the manager: {Detail}", invoice.InvoiceId, detail);
                    return new DeliveryResult(false, false, false, detail);
                }

                default:
                    return new DeliveryResult(false, false, true, response.StatusCode.ToString());
            }
        }
    }
}
