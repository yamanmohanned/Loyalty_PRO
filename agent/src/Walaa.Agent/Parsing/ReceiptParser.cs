using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Walaa.Agent.Parsing;

/// <summary>
/// Turns captured print bytes into an invoice number and a total, using a template
/// (docs/legacy/CLAUDE_v3.md §4.5).
/// </summary>
/// <remarks>
/// The governing rule, inherited from the barcode parsers in §13.6 and just as true
/// here: <b>a doubtful amount is worse than no amount.</b> A wrong total silently
/// corrupts a customer's balance and an end-of-day reconciliation; a missing one
/// surfaces on the calibration screen where a human looks at it. Every ambiguity below
/// therefore resolves to failure, not to a guess.
/// </remarks>
public sealed partial class ReceiptParser(PosTemplate template)
{
    private readonly PosTemplate _template = template;

    /// <param name="Success">True only when both the invoice number and the total were extracted.</param>
    /// <param name="InvoiceId">The invoice number, or null.</param>
    /// <param name="AmountGross">Whole dinars, or null.</param>
    /// <param name="Text">The decoded receipt — shown by the calibration screen (§4.7).</param>
    /// <param name="Codepage">Which codepage decoded it.</param>
    /// <param name="Failure">Why parsing failed, in Arabic, for the manager UI.</param>
    public readonly record struct ParseResult(
        bool Success,
        string? InvoiceId,
        int? AmountGross,
        string Text,
        int Codepage,
        string? Failure);

    public ParseResult Parse(ReadOnlySpan<byte> printJob)
    {
        var stripped = EscPos.Strip(printJob);
        var decoded = ArabicText.Decode(stripped.Text, _template.Codepage);
        var text = ArabicText.NormalizeDigits(decoded.Text);

        var lines = text
            .Split('\n')
            .Select(line => line.Replace('\r', ' ').Trim())
            .ToArray();

        var invoiceId = FindValue(lines, _template.InvoiceId);
        if (invoiceId is null)
        {
            return new ParseResult(false, null, null, text, decoded.Codepage, "لم يُعثر على رقم الفاتورة");
        }

        var totalText = FindValue(lines, _template.TotalAmount);
        if (totalText is null)
        {
            return new ParseResult(false, invoiceId, null, text, decoded.Codepage, "لم يُعثر على المبلغ الإجمالي");
        }

        var amount = ParseAmount(totalText, _template.Amount);
        if (amount is null)
        {
            return new ParseResult(false, invoiceId, null, text, decoded.Codepage, $"تعذّر تفسير المبلغ «{totalText}»");
        }

        return new ParseResult(true, invoiceId, amount, text, decoded.Codepage, null);
    }

    /// <summary>Applies one field rule to the receipt's lines.</summary>
    private static string? FindValue(string[] lines, PosTemplate.FieldRule rule)
    {
        if (string.IsNullOrWhiteSpace(rule.Pattern))
        {
            return null;
        }

        Regex regex;
        try
        {
            regex = new Regex(rule.Pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(250));
        }
        catch (ArgumentException)
        {
            // A template written by hand can contain a broken pattern. That is a
            // configuration error to surface, not a reason to crash a service that is
            // sitting in a shop's print path.
            return null;
        }

        var where = rule.Where.ToLowerInvariant();

        if (where == "anywhere" || rule.Labels.Count == 0)
        {
            foreach (var line in lines)
            {
                var match = TryMatch(regex, NormalizeArabic(line));
                if (match is not null)
                {
                    return match;
                }
            }

            return null;
        }

        var normalizedLabels = rule.Labels.Select(NormalizeArabic).ToArray();

        for (var i = 0; i < lines.Length; i += 1)
        {
            var normalizedLine = NormalizeArabic(lines[i]);

            var labelIndex = -1;
            var labelLength = 0;
            foreach (var label in normalizedLabels)
            {
                if (label.Length == 0)
                {
                    continue;
                }

                var found = normalizedLine.IndexOf(label, StringComparison.OrdinalIgnoreCase);
                if (found >= 0)
                {
                    labelIndex = found;
                    labelLength = label.Length;
                    break;
                }
            }

            if (labelIndex < 0)
            {
                continue;
            }

            if (where == "nextline")
            {
                if (i + 1 < lines.Length)
                {
                    var match = TryMatch(regex, NormalizeArabic(lines[i + 1]));
                    if (match is not null)
                    {
                        return match;
                    }
                }

                continue;
            }

            // sameLine: search after the label, so a label containing digits — "فاتورة 2"
            // as a heading — cannot be mistaken for the value.
            //
            // Sliced from the NORMALISED line, not the original. Folding presentation
            // forms expands ligatures (shaped lam-alef is one character, unshaped it is
            // two), so the two strings no longer share indices. The value itself is
            // digits and ASCII, which normalisation leaves alone.
            var after = labelIndex + labelLength;
            var remainder = after < normalizedLine.Length ? normalizedLine[after..] : string.Empty;

            var value = TryMatch(regex, remainder);

            // When the value STARTS at the label — "INV" labelling "INV-9824" — slicing
            // after the label leaves "-9824" and the invoice number loses its prefix.
            // Re-matching from the label's own start recovers the whole value, and the
            // longer match is the right one: a label that is a prefix of its value is
            // still part of the value.
            if (value is not null && remainder.StartsWith(value, StringComparison.Ordinal))
            {
                var fromLabel = TryMatch(regex, normalizedLine[labelIndex..]);
                if (fromLabel is not null && fromLabel.Length > value.Length)
                {
                    value = fromLabel;
                }
            }

            value ??= TryMatch(regex, normalizedLine);
            if (value is not null)
            {
                return value;
            }
        }

        return null;
    }

    private static string? TryMatch(Regex regex, string input)
    {
        Match match;
        try
        {
            match = regex.Match(input);
        }
        catch (RegexMatchTimeoutException)
        {
            return null;
        }

        if (!match.Success)
        {
            return null;
        }

        var group = match.Groups.Count > 1 ? match.Groups[1] : match.Groups[0];
        var value = group.Value.Trim();
        return value.Length == 0 ? null : value;
    }

    /// <summary>Converts a receipt's rendering of a number into whole dinars.</summary>
    private static int? ParseAmount(string raw, PosTemplate.AmountFormat format)
    {
        var text = ArabicText.NormalizeDigits(raw).Trim();

        foreach (var separator in format.ThousandsSeparators)
        {
            if (!string.IsNullOrEmpty(separator))
            {
                text = text.Replace(separator, string.Empty, StringComparison.Ordinal);
            }
        }

        var decimalSeparator = format.DecimalSeparator;
        if (!string.IsNullOrEmpty(decimalSeparator))
        {
            var split = text.Split(decimalSeparator, StringSplitOptions.None);
            if (split.Length == 2)
            {
                var fraction = split[1].TrimEnd();

                // `85000.00` is 85,000 dinars written by a POS configured for two
                // decimals. `85000.50` is either half a dinar — a unit that does not
                // circulate — or a misparse. Refusing it is the rule from §13.6: the
                // cost of no amount is a human looking; the cost of a wrong one is a
                // corrupted balance nobody notices.
                if (fraction.Length > 0 && fraction.Any(c => c != '0'))
                {
                    if (!format.AllowFractional)
                    {
                        return null;
                    }

                    // A template that opts in gets rounding rather than truncation: the
                    // data model is whole dinars either way, and rounding is the answer
                    // that is wrong by the smallest amount.
                    return double.TryParse(
                        $"{split[0]}.{fraction}",
                        NumberStyles.Float,
                        CultureInfo.InvariantCulture,
                        out var fractional) && fractional > 0
                        ? (int)Math.Round(fractional, MidpointRounding.AwayFromZero)
                        : null;
                }

                text = split[0];
            }
            else if (split.Length > 2)
            {
                return null; // Not a number this agent understands.
            }
        }

        if (text.Length == 0 || !text.All(char.IsAsciiDigit))
        {
            return null;
        }

        // A total that overflows Int32 is not a sale; it is a misparse that would be
        // rejected by the API's own bounds anyway (§13.5).
        return int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0
            ? value
            : null;
    }

    /// <summary>
    /// Folds the spelling variations that make Arabic label matching brittle.
    /// </summary>
    /// <remarks>
    /// A template author writes "الإجمالي"; the printer emits "الاجمالي" because its
    /// font lacks the hamza, "الإجمــالي" because the line was justified with tatweel,
    /// or the shaped presentation forms because it is a CP864 printer. All of them are
    /// the same word to a human and different strings to <c>IndexOf</c>.
    /// <para>
    /// This is NOT length-preserving — folding a shaped lam-alef ligature yields two
    /// characters — so callers must slice the normalised string, never map an index
    /// back onto the original.
    /// </para>
    /// </remarks>
    internal static string NormalizeArabic(string text)
    {
        // Presentation forms first: a CP864 receipt arrives shaped, and everything
        // below is written in terms of base letters.
        text = ArabicText.FoldPresentationForms(text);

        var builder = new StringBuilder(text.Length);

        foreach (var c in text)
        {
            switch (c)
            {
                case 'أ' or 'إ' or 'آ' or 'ٱ':
                    builder.Append('ا');
                    break;
                case 'ى':
                    builder.Append('ي');
                    break;
                case 'ة':
                    builder.Append('ه');
                    break;
                case 'ـ': // tatweel — decoration, never meaning
                    builder.Append(' ');
                    break;
                case >= 'ً' and <= 'ْ': // harakat
                    builder.Append(' ');
                    break;
                default:
                    builder.Append(c);
                    break;
            }
        }

        return builder.ToString();
    }
}
