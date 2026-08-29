using System.Text.Json;
using System.Text.Json.Serialization;
using Walaa.Agent.Capture;

namespace Walaa.Agent;

/// <summary>
/// Everything about this installation (CLAUDE_v3.md §4.3).
/// </summary>
/// <remarks>
/// Written by the installer and by the manager's Print Capture settings screen. The
/// detected capture mode is persisted here so a restart does not re-run detection —
/// and can be overridden by hand, because a store where auto-detection guessed wrong
/// should not need a new build.
/// </remarks>
public sealed record AgentSettings
{
    /// <summary>Where the Manager machine's API lives, e.g. <c>http://192.168.0.106:4000</c>.</summary>
    [JsonPropertyName("managerUrl")]
    public string ManagerUrl { get; init; } = "http://localhost:4000";

    [JsonPropertyName("username")]
    public string Username { get; init; } = string.Empty;

    [JsonPropertyName("password")]
    public string Password { get; init; } = string.Empty;

    /// <summary>The branch this till belongs to, e.g. <c>BAG-01</c>.</summary>
    [JsonPropertyName("branchCode")]
    public string BranchCode { get; init; } = string.Empty;

    /// <summary>Identifies this agent in the manager's capture-health view.</summary>
    [JsonPropertyName("agentId")]
    public string AgentId { get; init; } = "agent-1";

    /// <summary>
    /// The capture mode to use, or null to run detection at startup.
    /// </summary>
    /// <remarks>
    /// Null on a fresh install. Once detection has run, the winner is written here —
    /// §4.3 asks for the result to be persisted and manually overridable, and both come
    /// out of this one nullable field.
    /// </remarks>
    [JsonPropertyName("mode")]
    public CaptureMode? Mode { get; init; }

    [JsonPropertyName("spoolDirectory")]
    public string? SpoolDirectory { get; init; }

    [JsonPropertyName("virtualPrinterDropDirectory")]
    public string? VirtualPrinterDropDirectory { get; init; }

    [JsonPropertyName("realPrinterName")]
    public string? RealPrinterName { get; init; }

    [JsonPropertyName("virtualComPort")]
    public string? VirtualComPort { get; init; }

    [JsonPropertyName("realComPort")]
    public string? RealComPort { get; init; }

    [JsonPropertyName("networkListenPort")]
    public int NetworkListenPort { get; init; } = 9100;

    /// <summary>The printer's real address, e.g. <c>192.168.0.50:9100</c>.</summary>
    [JsonPropertyName("printerAddress")]
    public string? PrinterAddress { get; init; }

    /// <summary>Where undelivered captures wait. Must be writable by the service account.</summary>
    [JsonPropertyName("queueDirectory")]
    public string QueueDirectory { get; init; } =
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Walaa",
            "agent",
            "queue");

    [JsonPropertyName("templatePath")]
    public string TemplatePath { get; init; } = "pos-template.json";

    /// <summary>
    /// Keep the decoded receipt text with the capture.
    /// </summary>
    /// <remarks>
    /// Off by default. The text is genuinely useful for tuning a template and for the
    /// calibration flow (§4.7), and it is also receipt content — §4.5 says to retain it
    /// only when the merchant enables diagnostics.
    /// </remarks>
    [JsonPropertyName("retainReceiptText")]
    public bool RetainReceiptText { get; init; }

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    public static AgentSettings Load(string path) =>
        File.Exists(path)
            ? JsonSerializer.Deserialize<AgentSettings>(File.ReadAllText(path), Options) ?? new AgentSettings()
            : new AgentSettings();

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this, Options));
    }
}
