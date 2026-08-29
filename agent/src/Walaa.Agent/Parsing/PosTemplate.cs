using System.Text.Json;
using System.Text.Json.Serialization;

namespace Walaa.Agent.Parsing;

/// <summary>
/// The external parsing rules (CLAUDE_v3.md §4.5 step 3).
/// </summary>
/// <remarks>
/// <para>
/// <b>Nothing about a particular POS is compiled into this agent.</b> Where the invoice
/// number lives, what the total is labelled, which codepage the printer uses — all of it
/// is here, in a file the calibration flow (§4.7) can write. That is the difference
/// between supporting a new merchant's POS being a new template and it being a new
/// project.
/// </para>
/// <para>
/// The shipped template is a starting point built against synthetic fixtures, not
/// against Al-Bayan's real output, which has not been captured yet (§12.6). It is
/// expected to be replaced by calibration at the first store.
/// </para>
/// </remarks>
public sealed record PosTemplate
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "default";

    [JsonPropertyName("version")]
    public int Version { get; init; } = 1;

    /// <summary><c>"auto"</c>, <c>"cp864"</c>, <c>"windows-1256"</c>, or a numeric codepage.</summary>
    [JsonPropertyName("codepage")]
    public string Codepage { get; init; } = "auto";

    [JsonPropertyName("invoiceId")]
    public FieldRule InvoiceId { get; init; } = new();

    [JsonPropertyName("totalAmount")]
    public FieldRule TotalAmount { get; init; } = new();

    [JsonPropertyName("amount")]
    public AmountFormat Amount { get; init; } = new();

    /// <summary>How to find one value on a receipt.</summary>
    public sealed record FieldRule
    {
        /// <summary>
        /// Text that marks the line. Matched after Arabic normalisation, so a template
        /// written with "الإجمالي" still matches a receipt printing "الاجمالي".
        /// </summary>
        [JsonPropertyName("labels")]
        public IReadOnlyList<string> Labels { get; init; } = [];

        /// <summary>
        /// <c>sameLine</c> (default) — the value follows the label.
        /// <c>nextLine</c> — the label is a heading and the value is beneath it.
        /// <c>anywhere</c> — no label; the pattern alone identifies the value.
        /// </summary>
        [JsonPropertyName("where")]
        public string Where { get; init; } = "sameLine";

        /// <summary>A regex whose first capturing group is the value.</summary>
        [JsonPropertyName("pattern")]
        public string Pattern { get; init; } = string.Empty;
    }

    /// <summary>How numbers are written on this POS's receipts.</summary>
    public sealed record AmountFormat
    {
        [JsonPropertyName("thousandsSeparators")]
        public IReadOnlyList<string> ThousandsSeparators { get; init; } = [",", " ", "٬"];

        [JsonPropertyName("decimalSeparator")]
        public string DecimalSeparator { get; init; } = ".";

        /// <summary>
        /// Whether a fractional part may carry value.
        /// <para>
        /// False for IQD, which has no minor unit in practice (§5.4). A receipt printing
        /// <c>85000.00</c> is still 85,000 dinars and parses; one printing
        /// <c>85000.50</c> means something this agent does not understand, and is
        /// rejected rather than guessed — a wrong amount silently corrupts a customer's
        /// balance, while no amount merely asks a human to look.
        /// </para>
        /// </summary>
        [JsonPropertyName("allowFractional")]
        public bool AllowFractional { get; init; }
    }

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        WriteIndented = true,
    };

    public static PosTemplate Load(string path)
    {
        var json = File.ReadAllText(path);
        return Parse(json);
    }

    public static PosTemplate Parse(string json) =>
        JsonSerializer.Deserialize<PosTemplate>(json, SerializerOptions)
        ?? throw new InvalidDataException("pos-template.json is empty or null");

    public string ToJson() => JsonSerializer.Serialize(this, SerializerOptions);
}
