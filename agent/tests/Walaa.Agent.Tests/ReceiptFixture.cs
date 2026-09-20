using System.Text;
using Walaa.Agent.Parsing;

namespace Walaa.Agent.Tests;

/// <summary>
/// Builds synthetic ESC/POS print jobs to parse against (docs/legacy/CLAUDE_v3.md §12.6).
/// </summary>
/// <remarks>
/// <para>
/// Real Al-Bayan bytes have not been captured yet, and §12.6 is explicit that this must
/// not block. These fixtures are the substitute, and they are built rather than stored
/// as opaque binaries so that a reviewer can see exactly which commands and which
/// encoding each test exercises — a blob in the repo proves nothing about what it
/// contains.
/// </para>
/// <para>
/// What matters is that they are <em>hostile in the ways a real receipt is</em>: the
/// text is wrapped in the initialise/justify/cut commands a POS actually emits, a
/// barcode and a raster logo are included because their binary payloads are what a
/// naive stripper leaks into the text, and the numbers appear in both digit systems.
/// </para>
/// </remarks>
internal sealed class ReceiptFixture
{
    private readonly List<byte> _bytes = [];
    private readonly Encoding _encoding;

    static ReceiptFixture()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    private readonly int _codepage;

    private ReceiptFixture(int codepage)
    {
        _codepage = codepage;
        _encoding = Encoding.GetEncoding(codepage);
    }

    /// <summary>
    /// Base Arabic letter → the CP864 byte whose glyph is that letter, shaped.
    /// </summary>
    /// <remarks>
    /// <para>
    /// CP864 stores Arabic <b>presentation forms</b>, not base letters, and .NET's CP864
    /// encoder has no mapping from base letters at all — it emits <c>'?'</c> for every
    /// one of them. Encoding a fixture with it would produce a receipt containing no
    /// Arabic whatsoever, and the tests would then be proving nothing about Arabic.
    /// </para>
    /// <para>
    /// So the table is built the other way round, from the decoder: every byte is
    /// decoded, folded to its base letter with NFKC, and recorded. The result encodes
    /// Arabic the way a POS driver does when it shapes text for a CP864 printer, which
    /// is what the parser has to cope with in a shop.
    /// </para>
    /// </remarks>
    private static readonly Dictionary<char, byte> Cp864BaseToByte = BuildCp864Map();

    private static Dictionary<char, byte> BuildCp864Map()
    {
        // Registered here, not only in the static constructor: C# runs static FIELD
        // INITIALISERS before the static constructor body, so the map would otherwise be
        // built before the provider exists — which fails with "No data is available for
        // encoding 864" and looks like a missing package rather than an ordering bug.
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        var encoding = Encoding.GetEncoding(ArabicText.Cp864);
        var map = new Dictionary<char, byte>();

        for (var b = 0x80; b <= 0xFF; b += 1)
        {
            var decoded = encoding.GetString([(byte)b]);
            if (decoded.Length == 0)
            {
                continue;
            }

            var folded = ArabicText.FoldPresentationForms(decoded);

            // Ligatures fold to more than one character and cannot represent a single
            // base letter; skip them.
            if (folded.Length != 1)
            {
                continue;
            }

            var baseChar = folded[0];
            if (baseChar is >= '؀' and <= 'ۿ')
            {
                // First byte wins. Later bytes are other shapes of the same letter, and
                // any one of them decodes back to the same base letter.
                map.TryAdd(baseChar, (byte)b);
            }
        }

        return map;
    }

    /// <summary>Encodes text the way this fixture's printer would receive it.</summary>
    private byte[] Encode(string text)
    {
        if (_codepage != ArabicText.Cp864)
        {
            return _encoding.GetBytes(text);
        }

        var bytes = new List<byte>(text.Length);
        foreach (var c in text)
        {
            if (Cp864BaseToByte.TryGetValue(c, out var mapped))
            {
                bytes.Add(mapped);
                continue;
            }

            if (c < 0x80)
            {
                bytes.Add((byte)c);
                continue;
            }

            // What a real CP864 driver does with a character its table lacks: print the
            // closest form it has. Hamza-carrying alefs become bare alef, which is
            // exactly the "the printer emits الاجمالي because its font lacks the hamza"
            // case §4.5 anticipates — and the reason the parser folds these variants.
            var folded = c switch
            {
                'أ' or 'إ' or 'آ' or 'ٱ' => 'ا',
                'ة' => 'ه',
                'ى' => 'ي',
                _ => c,
            };

            if (folded != c && Cp864BaseToByte.TryGetValue(folded, out var foldedByte))
            {
                bytes.Add(foldedByte);
                continue;
            }

            // Diacritics and tatweel: a thermal printer has no combining marks and
            // simply does not print them.
            if (c is >= 'ً' and <= 'ْ' or 'ـ')
            {
                continue;
            }

            bytes.Add((byte)'?');
        }

        return [.. bytes];
    }

    public static ReceiptFixture Cp864() => new(ArabicText.Cp864);

    public static ReceiptFixture Windows1256() => new(ArabicText.Windows1256);

    /// <summary>ESC @ — what every POS sends first.</summary>
    public ReceiptFixture Initialise()
    {
        _bytes.AddRange([0x1B, 0x40]);
        return this;
    }

    /// <summary>ESC t n — the printer's own claim about its code table.</summary>
    public ReceiptFixture SelectCodepage(byte n)
    {
        _bytes.AddRange([0x1B, 0x74, n]);
        return this;
    }

    /// <summary>ESC a n — justification. Emitted constantly by real receipts.</summary>
    public ReceiptFixture Align(byte mode)
    {
        _bytes.AddRange([0x1B, 0x61, mode]);
        return this;
    }

    /// <summary>ESC ! n — print mode (double height for a header, and so on).</summary>
    public ReceiptFixture PrintMode(byte mode)
    {
        _bytes.AddRange([0x1B, 0x21, mode]);
        return this;
    }

    public ReceiptFixture Line(string text)
    {
        _bytes.AddRange(Encode(text));
        _bytes.Add(0x0A);
        return this;
    }

    /// <summary>A label and value separated by a tab, as column layouts do.</summary>
    public ReceiptFixture Columns(string label, string value)
    {
        _bytes.AddRange(Encode(label));
        _bytes.Add(0x09);
        _bytes.AddRange(Encode(value));
        _bytes.Add(0x0A);
        return this;
    }

    /// <summary>
    /// GS k — a Code 128 barcode, NUL-terminated form.
    /// </summary>
    /// <remarks>
    /// Included in the fixtures on purpose. Its payload is ASCII digits, so a stripper
    /// that fails to skip it leaks a number into the text that looks exactly like an
    /// invoice total — the most dangerous parsing failure available, because the result
    /// is plausible rather than obviously broken.
    /// </remarks>
    public ReceiptFixture Barcode(string payload)
    {
        _bytes.AddRange([0x1D, 0x6B, 0x49]); // GS k 73 (CODE128, length-prefixed form B)
        _bytes.Add((byte)payload.Length);
        _bytes.AddRange(Encoding.ASCII.GetBytes(payload));
        return this;
    }

    /// <summary>GS v 0 — a raster logo, whose payload is arbitrary binary.</summary>
    public ReceiptFixture RasterLogo(int widthBytes, int height)
    {
        _bytes.AddRange([0x1D, 0x76, 0x30, 0x00]);
        _bytes.Add((byte)(widthBytes & 0xFF));
        _bytes.Add((byte)(widthBytes >> 8));
        _bytes.Add((byte)(height & 0xFF));
        _bytes.Add((byte)(height >> 8));

        // Deliberately including bytes that decode to digits and to Arabic letters, so
        // a leak shows up as plausible text rather than as obvious rubbish.
        for (var i = 0; i < widthBytes * height; i += 1)
        {
            _bytes.Add((byte)(0x30 + (i % 10)));
        }

        return this;
    }

    /// <summary>ESC d n — feed, then GS V — cut. How every receipt ends.</summary>
    public ReceiptFixture Cut()
    {
        _bytes.AddRange([0x1B, 0x64, 0x04]);
        _bytes.AddRange([0x1D, 0x56, 0x00]);
        return this;
    }

    public byte[] Build() => [.. _bytes];

    /// <summary>Rewrites ASCII digits as Arabic-Indic ones (٠١٢٣٤٥٦٧٨٩).</summary>
    /// <remarks>
    /// Not a curiosity: this is the default on a printer configured for Arabic, and
    /// §4.5 requires both to parse. A total captured but not parsed is still a failure.
    /// </remarks>
    public static string ToArabicIndic(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (var c in text)
        {
            builder.Append(char.IsAsciiDigit(c) ? (char)('٠' + (c - '0')) : c);
        }

        return builder.ToString();
    }

    /// <summary>
    /// A complete receipt in the shape an Arabic thermal POS prints one.
    /// </summary>
    public static byte[] Receipt(
        int codepage,
        string invoiceId,
        string total,
        bool arabicIndicDigits = false,
        bool withBarcode = true,
        bool withLogo = true)
    {
        var fixture = codepage == ArabicText.Cp864 ? Cp864() : Windows1256();

        string Digits(string value) => arabicIndicDigits ? ToArabicIndic(value) : value;

        fixture
            .Initialise()
            .SelectCodepage(codepage == ArabicText.Cp864 ? (byte)0x16 : (byte)0x21)
            .Align(1)
            .PrintMode(0x30);

        if (withLogo)
        {
            fixture.RasterLogo(widthBytes: 8, height: 16);
        }

        fixture
            .Line("سوبرماركت الرشيد")
            .PrintMode(0x00)
            .Line("بغداد - الكرادة")
            .Line(Digits("07701234567"))
            .Align(0)
            .Line("--------------------------------")
            .Columns("رقم الفاتورة", Digits(invoiceId))
            .Columns("التاريخ", Digits("2026/08/29"))
            .Line("--------------------------------")
            .Columns("رز عنبر ٥ كغم", Digits("12,500"))
            .Columns("زيت دوار الشمس", Digits("8,750"))
            .Columns("سكر ١ كغم", Digits("1,250"))
            .Line("--------------------------------")
            .Columns("الإجمالي", Digits(total))
            .Line("--------------------------------")
            .Align(1)
            .Line("شكراً لتسوّقكم معنا");

        if (withBarcode)
        {
            fixture.Barcode(invoiceId);
        }

        return fixture.Cut().Build();
    }
}
