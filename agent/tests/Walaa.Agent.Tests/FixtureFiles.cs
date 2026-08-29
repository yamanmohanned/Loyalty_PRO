using Walaa.Agent.Parsing;
using Xunit;

namespace Walaa.Agent.Tests;

/// <summary>
/// Writes the synthetic receipts to <c>agent/fixtures/</c> as real byte files.
/// </summary>
/// <remarks>
/// The tests build their fixtures in memory, which is the right thing for a test. These
/// files exist for the things a test cannot do: dropping a receipt into a spool
/// directory to exercise the agent end to end, feeding the calibration screen (§4.7)
/// something to display, and — the one that matters most — sitting next to the real
/// Al-Bayan bytes when they finally arrive (§12.6) so the two can be compared.
/// </remarks>
public class FixtureFiles
{
    [Fact]
    public void Emit()
    {
        var directory = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "fixtures"));
        Directory.CreateDirectory(directory);

        var cases = new (string Name, byte[] Bytes)[]
        {
            ("receipt-cp864-western-digits.bin",
                ReceiptFixture.Receipt(ArabicText.Cp864, "INV-9824", "85,000")),
            ("receipt-cp864-arabic-indic-digits.bin",
                ReceiptFixture.Receipt(ArabicText.Cp864, "INV-9825", "42,000", arabicIndicDigits: true)),
            ("receipt-windows1256-western-digits.bin",
                ReceiptFixture.Receipt(ArabicText.Windows1256, "INV-9826", "12,750")),
            ("receipt-windows1256-arabic-indic-digits.bin",
                ReceiptFixture.Receipt(ArabicText.Windows1256, "INV-9827", "7,500", arabicIndicDigits: true)),
            ("receipt-no-total.bin", ReceiptFixture.Cp864()
                .Initialise()
                .Line("سوبرماركت الرشيد")
                .Columns("رقم الفاتورة", "INV-9828")
                .Line("شكراً لتسوّقكم")
                .Cut()
                .Build()),
        };

        foreach (var (name, bytes) in cases)
        {
            File.WriteAllBytes(Path.Combine(directory, name), bytes);
        }

        // Every emitted fixture must parse the way its name claims, or it is misleading
        // rather than useful.
        var parser = new ReceiptParser(
            PosTemplate.Load(Path.Combine(AppContext.BaseDirectory, "pos-template.json")));

        Assert.True(parser.Parse(cases[0].Bytes).Success);
        Assert.Equal(42_000, parser.Parse(cases[1].Bytes).AmountGross);
        Assert.Equal(12_750, parser.Parse(cases[2].Bytes).AmountGross);
        Assert.Equal(7_500, parser.Parse(cases[3].Bytes).AmountGross);
        Assert.False(parser.Parse(cases[4].Bytes).Success);
    }
}
