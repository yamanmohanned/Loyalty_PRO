using System.Text;

namespace Walaa.Agent.Parsing;

/// <summary>
/// Decoding a receipt's bytes into text, and normalising the digits in it
/// (CLAUDE_v3.md §4.5 step 2).
/// </summary>
/// <remarks>
/// <para>
/// Arabic-market thermal printers use <b>CP864</b> or <b>Windows-1256</b>, not UTF-8.
/// Decode with the wrong one and every Arabic label becomes mojibake — which means the
/// template cannot find "الإجمالي", which means the total is never extracted. §4.5 is
/// explicit that a captured-but-unparsed total is still a failure.
/// </para>
/// <para>
/// Neither codepage is in .NET's default set; <c>CodePagesEncodingProvider</c> has to be
/// registered before <c>Encoding.GetEncoding</c> will return them, which is done here in
/// a static constructor so no caller can forget.
/// </para>
/// </remarks>
public static class ArabicText
{
    /// <summary>DOS Arabic — the older of the two, still common on thermal hardware.</summary>
    public const int Cp864 = 864;

    /// <summary>Windows Arabic.</summary>
    public const int Windows1256 = 1256;

    static ArabicText()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    /// <summary>The codepages tried during auto-detection, in the order they are scored.</summary>
    public static readonly IReadOnlyList<int> Candidates = [Cp864, Windows1256, 65001];

    /// <summary>Decodes with a named codepage. <c>"auto"</c> runs detection.</summary>
    public static DecodeResult Decode(ReadOnlySpan<byte> bytes, string codepage)
    {
        if (string.Equals(codepage, "auto", StringComparison.OrdinalIgnoreCase))
        {
            return Detect(bytes);
        }

        var page = ResolveCodepage(codepage);
        return new DecodeResult(GetEncoding(page).GetString(bytes), page, Detected: false, Score: 0);
    }

    /// <param name="Text">The decoded receipt.</param>
    /// <param name="Codepage">Which codepage produced it.</param>
    /// <param name="Detected">True when it was chosen by scoring rather than configured.</param>
    /// <param name="Score">The winning score, for the calibration screen to display.</param>
    public readonly record struct DecodeResult(string Text, int Codepage, bool Detected, int Score);

    /// <summary>
    /// Picks the codepage that yields the most plausible Arabic receipt.
    /// </summary>
    /// <remarks>
    /// Scoring, rather than trusting the printer's <c>ESC t</c> operand, because that
    /// operand's meaning varies by manufacturer — the same value is CP864 on one printer
    /// and something else on another. What does not vary is what a correctly decoded
    /// Arabic receipt looks like: Arabic letters, digits, and very few replacement
    /// characters. Detection therefore measures the result rather than trusting the
    /// claim.
    /// </remarks>
    public static DecodeResult Detect(ReadOnlySpan<byte> bytes)
    {
        var best = new DecodeResult(string.Empty, Cp864, Detected: true, Score: int.MinValue);

        foreach (var page in Candidates)
        {
            string text;
            try
            {
                text = GetEncoding(page).GetString(bytes);
            }
            catch (ArgumentException)
            {
                continue;
            }

            var score = ScoreArabic(text);
            if (score > best.Score)
            {
                best = new DecodeResult(text, page, Detected: true, Score: score);
            }
        }

        return best;
    }

    /// <summary>
    /// How much this decoding looks like a real Arabic receipt.
    /// </summary>
    /// <remarks>
    /// Arabic letters are the strongest positive signal, because they are what the
    /// template's labels are made of. Replacement characters and stray control
    /// characters are the strongest negative: they are what a wrong codepage produces,
    /// and their absence is not enough on its own — a Latin-1 misread of Arabic bytes
    /// produces perfectly valid accented letters and no replacement characters at all,
    /// which is why letters are counted rather than errors merely subtracted.
    /// </remarks>
    private static int ScoreArabic(string text)
    {
        var score = 0;

        foreach (var c in text)
        {
            if (c is >= '؀' and <= 'ۿ')
            {
                score += 3; // Arabic block: letters, Arabic-Indic digits, punctuation.
            }
            else if (c is >= 'ﭐ' and <= '﷿' or >= 'ﹰ' and <= '﻿')
            {
                // Arabic Presentation Forms A and B — the SHAPED glyphs.
                //
                // Scoring these as Arabic is not a nicety; without it detection is
                // actively wrong. CP864 stores shaped forms, so a correctly decoded
                // CP864 receipt is made almost entirely of this range. Scored as
                // "unexpected high characters" it lost to a Windows-1256 misread that
                // happened to produce a few base-Arabic letters out of mojibake — the
                // wrong codepage winning on the strength of its own garbage.
                score += 3;
            }
            else if (char.IsAsciiDigit(c) || c is ' ' or '\n' or '\r' or '\t' or '.' or ',' or '-' or ':')
            {
                score += 1; // Receipt scaffolding: numbers, separators, layout.
            }
            else if (char.IsAsciiLetter(c))
            {
                score += 1; // "INV", "Total" — Arabic receipts carry some Latin.
            }
            else if (c == '�')
            {
                score -= 5; // The unmistakable mark of a wrong codepage.
            }
            else if (char.IsControl(c))
            {
                score -= 3;
            }
            else if (c > 'ÿ')
            {
                score -= 1; // Plausible-looking but out-of-place: CJK, symbols.
            }
        }

        return score;
    }

    private static Encoding GetEncoding(int codepage) => Encoding.GetEncoding(codepage);

    private static int ResolveCodepage(string codepage) => codepage.Trim().ToLowerInvariant() switch
    {
        "cp864" or "864" or "ibm864" => Cp864,
        "windows-1256" or "cp1256" or "1256" => Windows1256,
        "utf-8" or "utf8" or "65001" => 65001,
        _ when int.TryParse(codepage, out var numeric) => numeric,
        _ => throw new ArgumentException($"Unknown codepage '{codepage}'", nameof(codepage)),
    };


    /// <summary>
    /// Folds Arabic <b>presentation forms</b> back to base letters.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the correction for a failure that would have been very hard to diagnose
    /// in a shop. CP864 does not store Arabic base letters at all — it stores the
    /// <em>shaped</em> glyphs (initial, medial, final, isolated), so a receipt decoded
    /// from CP864 comes back as U+FE70–U+FEFF, not as U+0600–U+06FF. A template whose
    /// label reads "الإجمالي" in ordinary base letters therefore matches nothing, and
    /// the agent looks like it is capturing perfectly and simply never parsing.
    /// </para>
    /// <para>
    /// NFKC is exactly the right tool: Unicode defines these presentation forms as
    /// compatibility equivalents of their base letters, so normalisation undoes the
    /// shaping. It also expands ligatures — lam-alef is one character shaped and two
    /// unshaped — which is why callers must not assume normalisation preserves length.
    /// </para>
    /// </remarks>
    public static string FoldPresentationForms(string text) =>
        text.IsNormalized(NormalizationForm.FormKC) ? text : text.Normalize(NormalizationForm.FormKC);

    /// <summary>
    /// Rewrites Arabic-Indic digits as ASCII ones.
    /// </summary>
    /// <remarks>
    /// A receipt that prints its total as ٨٥٠٠٠ is not an edge case in this market; it
    /// is the default on a printer configured for Arabic. §4.5 calls this out
    /// explicitly, and the failure it prevents is silent — the label is found, the line
    /// is found, and the number simply does not parse.
    /// <para>
    /// Both blocks are handled: U+0660–0669 (Arabic-Indic) and U+06F0–06F9 (Extended,
    /// used for Persian and Urdu and turned up by some printer firmware).
    /// </para>
    /// </remarks>
    public static string NormalizeDigits(string text)
    {
        Span<char> buffer = text.Length <= 512 ? stackalloc char[text.Length] : new char[text.Length];

        for (var i = 0; i < text.Length; i += 1)
        {
            var c = text[i];
            buffer[i] = c switch
            {
                >= '٠' and <= '٩' => (char)('0' + (c - '٠')),
                >= '۰' and <= '۹' => (char)('0' + (c - '۰')),
                _ => c,
            };
        }

        return new string(buffer);
    }
}
