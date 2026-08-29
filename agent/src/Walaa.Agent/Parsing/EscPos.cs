namespace Walaa.Agent.Parsing;

/// <summary>
/// Strips ESC/POS control sequences from a captured print job, leaving the text
/// (CLAUDE_v3.md §4.5 step 1).
/// </summary>
/// <remarks>
/// <para>
/// A receipt on the wire is not text with a few escape codes sprinkled in. It is a
/// command stream that happens to contain text, and some of those commands carry
/// <em>binary payloads</em> — a barcode's data, a raster logo's bitmap. Skipping a
/// command byte but not its payload spills that binary into the "text", where it
/// reliably produces a total that looks almost right.
/// </para>
/// <para>
/// The commands whose payload length must be computed rather than guessed are handled
/// explicitly below. Everything else consumes its fixed parameter count. An unknown
/// command consumes only itself, which is the safe failure: at worst a stray byte
/// survives into the text, where the parser's patterns ignore it, rather than the
/// stripper swallowing the line the total was on.
/// </para>
/// </remarks>
public static class EscPos
{
    private const byte ESC = 0x1B;
    private const byte GS = 0x1D;
    private const byte FS = 0x1C;
    private const byte DLE = 0x10;

    /// <summary>The bytes that survive stripping, plus the codepage the job asked for.</summary>
    /// <param name="Text">Printable bytes, still undecoded — the codepage decision comes later.</param>
    /// <param name="CodepageCommand">
    /// The operand of the last <c>ESC t n</c> seen, or null. A hint only: the mapping
    /// from <c>n</c> to an actual codepage is printer-specific, so this is used to
    /// break ties during detection and never on its own.
    /// </param>
    public readonly record struct StripResult(byte[] Text, byte? CodepageCommand);

    /// <summary>
    /// Removes control sequences, keeping printable bytes, line feeds and tabs.
    /// </summary>
    public static StripResult Strip(ReadOnlySpan<byte> data)
    {
        var output = new List<byte>(data.Length);
        byte? codepage = null;
        var i = 0;

        while (i < data.Length)
        {
            var b = data[i];

            switch (b)
            {
                case ESC:
                    i = SkipEsc(data, i, ref codepage);
                    continue;

                case GS:
                    i = SkipGs(data, i);
                    continue;

                case FS:
                    // FS commands are two bytes plus, in a few cases, one operand. The
                    // conservative skip of two is right for the Arabic-relevant ones
                    // (FS & / FS . toggle Kanji mode and are no-ops here).
                    i += 2;
                    continue;

                case DLE:
                    // Real-time status requests: DLE EOT n, DLE ENQ n, DLE DC4 …
                    i += 3;
                    continue;

                case 0x0A: // LF — the line structure the template depends on.
                case 0x0D: // CR
                case 0x09: // HT — column layouts use it between a label and its value.
                    output.Add(b);
                    i += 1;
                    continue;

                default:
                    // Every other control byte is discarded; anything printable is kept,
                    // including the high bytes that carry Arabic in CP864 and 1256.
                    if (b >= 0x20)
                    {
                        output.Add(b);
                    }

                    i += 1;
                    continue;
            }
        }

        return new StripResult(output.ToArray(), codepage);
    }

    /// <summary>Advances past one ESC command, returning the next index to read.</summary>
    private static int SkipEsc(ReadOnlySpan<byte> data, int i, ref byte? codepage)
    {
        // A trailing ESC with nothing after it: consume it and stop.
        if (i + 1 >= data.Length)
        {
            return data.Length;
        }

        var command = data[i + 1];

        switch (command)
        {
            // ESC t n — select character code table. The one command that tells us
            // something about the encoding, recorded as a hint (see StripResult).
            case 0x74 when i + 2 < data.Length:
                codepage = data[i + 2];
                return i + 3;

            // ESC * m nL nH [data] — bit-image mode. The payload length depends on the
            // mode: 8-dot modes take one byte per column, 24-dot modes take three.
            case 0x2A when i + 4 < data.Length:
            {
                var mode = data[i + 2];
                var columns = data[i + 3] | (data[i + 4] << 8);
                var bytesPerColumn = mode is 32 or 33 ? 3 : 1;
                return i + 5 + (columns * bytesPerColumn);
            }

            // Commands taking two operands.
            case 0x24: // ESC $ nL nH — absolute print position
            case 0x5C: // ESC \ nL nH — relative print position
            case 0x44: // ESC D n1 n2 … NUL — tab positions (terminated, handled below)
                return command == 0x44
                    ? SkipUntilNul(data, i + 2)
                    : i + 4;

            // Commands taking three operands.
            case 0x70: // ESC p m t1 t2 — pulse the cash drawer
            case 0x43: // ESC C n — page length
                return command == 0x70 ? i + 5 : i + 3;

            // Commands taking one operand. Listed rather than defaulted, so that adding
            // a command is a deliberate act and an unlisted one fails safe.
            case 0x21: // ESC ! n   print mode
            case 0x2D: // ESC - n   underline
            case 0x32: // ESC 2     line spacing (no operand, handled by fallthrough below)
            case 0x33: // ESC 3 n   line spacing
            case 0x45: // ESC E n   emphasis
            case 0x47: // ESC G n   double strike
            case 0x4A: // ESC J n   feed n dots
            case 0x4D: // ESC M n   font
            case 0x52: // ESC R n   international character set
            case 0x53: // ESC S     standard mode
            case 0x56: // ESC V n   rotate
            case 0x57: // ESC W …   set print area
            case 0x61: // ESC a n   justification
            case 0x63: // ESC c … n paper sensor
            case 0x64: // ESC d n   feed n lines
            case 0x66: // ESC f …   feed
            case 0x69: // ESC i     partial cut
            case 0x6D: // ESC m     partial cut
            case 0x7B: // ESC { n   upside-down
                return command == 0x32 || command == 0x53 || command == 0x69 || command == 0x6D
                    ? i + 2
                    : i + 3;

            // ESC @ — initialise. No operand.
            case 0x40:
                return i + 2;

            default:
                // Unknown: consume ESC and the command byte only. A stray operand that
                // survives into the text is harmless; swallowing a line is not.
                return i + 2;
        }
    }

    /// <summary>Advances past one GS command, returning the next index to read.</summary>
    private static int SkipGs(ReadOnlySpan<byte> data, int i)
    {
        if (i + 1 >= data.Length)
        {
            return data.Length;
        }

        var command = data[i + 1];

        switch (command)
        {
            // GS k m … — print barcode. Two forms, and getting this wrong is how a
            // barcode's digits end up looking like a receipt total.
            case 0x6B when i + 2 < data.Length:
            {
                var symbology = data[i + 2];
                if (symbology >= 65)
                {
                    // Form B: GS k m n d1..dn — length-prefixed.
                    if (i + 3 >= data.Length)
                    {
                        return data.Length;
                    }

                    var length = data[i + 3];
                    return i + 4 + length;
                }

                // Form A: GS k m d1..dk NUL — NUL-terminated.
                return SkipUntilNul(data, i + 3);
            }

            // GS v 0 m xL xH yL yH [data] — raster bit image. The payload is
            // (xL + xH*256) * (yL + yH*256) bytes, and it is large.
            case 0x76 when i + 7 < data.Length && data[i + 2] == 0x30:
            {
                var widthBytes = data[i + 4] | (data[i + 5] << 8);
                var height = data[i + 6] | (data[i + 7] << 8);
                return i + 8 + (widthBytes * height);
            }

            // GS ( … pL pH — the extended command family is length-prefixed.
            case 0x28 when i + 4 < data.Length:
            {
                var parameters = data[i + 3] | (data[i + 4] << 8);
                return i + 5 + parameters;
            }

            // Two operands.
            case 0x4C: // GS L nL nH — left margin
            case 0x57: // GS W nL nH — print area width
                return i + 4;

            // One operand.
            case 0x21: // GS ! n   character size
            case 0x42: // GS B n   reverse video
            case 0x48: // GS H n   HRI position
            case 0x56: // GS V m   cut
            case 0x66: // GS f n   HRI font
            case 0x68: // GS h n   barcode height
            case 0x72: // GS r n   status transmission
            case 0x77: // GS w n   barcode width
                return i + 3;

            default:
                return i + 2;
        }
    }

    private static int SkipUntilNul(ReadOnlySpan<byte> data, int start)
    {
        var i = start;
        while (i < data.Length && data[i] != 0x00)
        {
            i += 1;
        }

        return Math.Min(i + 1, data.Length);
    }
}
