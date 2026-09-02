import type { DiscountSlip } from '@walaa/shared-types';
import { PrintableSlip } from './Printable';
import { locale } from '../lib/locale';

/**
 * The discount slip, on screen, before the paper comes out (operator request,
 * 2026-09-02).
 *
 * **It renders `PrintableSlip` itself — the identical component the printer is
 * handed.** That is the whole design. A preview built as its own markup is a second
 * description of the same paper, and §12.27 has already shown what happens to a
 * second description: it stays plausible while it drifts, and the first person to
 * notice is a customer holding a slip that does not match what they were shown.
 *
 * Sizing is 1:1 in proportion. The slip is authored in `mm` and `pt` for an 80 mm
 * roll and those are real CSS units, so at `width: 80mm` the browser lays it out at
 * true paper size — then `zoom` magnifies the whole block uniformly, because true
 * size read across a counter is too small to be worth showing.
 *
 * `zoom` rather than `transform: scale()` deliberately: zoom reflows, so the
 * magnified block occupies the space it actually takes and cannot overlap what
 * follows it (§6.5). A scaled block keeps its original layout box and the next
 * element climbs into it.
 *
 * The preview is NOT inside `#print-root`. The print stylesheet hides everything
 * outside that node, so this block cannot print itself and the customer can never
 * end up with two slips.
 */
export function SlipPreview({
  shopName,
  slip,
}: {
  shopName: string;
  slip: DiscountSlip;
}): JSX.Element {
  return (
    <figure className="m-0 flex flex-col items-center gap-3">
      <figcaption className="text-center">
        <span className="block text-base font-semibold text-ink">{locale.preview.title}</span>
        <span className="mt-1 block text-sm text-steel">{locale.preview.hint}</span>
      </figcaption>

      <div className="w-full overflow-x-auto">
        {/* Paper: pure white, black text, a shadow rather than a border — a receipt
            has no printed frame, and drawing one would show the customer a line the
            printed slip does not have. */}
        <div
          className="mx-auto bg-white text-black shadow-[0_1px_3px_rgba(17,24,39,0.14),0_10px_28px_-10px_rgba(17,24,39,0.22)]"
          style={{ width: '80mm', zoom: 1.25, padding: '4mm 3mm 6mm', colorScheme: 'light' }}
        >
          <PrintableSlip shopName={shopName} slip={slip} />
        </div>

        {/* The torn edge, purely so the block reads as paper at a glance and is never
            mistaken for a form to fill in. */}
        <div
          aria-hidden
          className="mx-auto bg-white"
          style={{
            width: '80mm',
            zoom: 1.25,
            height: '3mm',
            clipPath:
              'polygon(0 0, 100% 0, 100% 30%, 96% 100%, 92% 30%, 88% 100%, 84% 30%, 80% 100%, 76% 30%, 72% 100%, 68% 30%, 64% 100%, 60% 30%, 56% 100%, 52% 30%, 48% 100%, 44% 30%, 40% 100%, 36% 30%, 32% 100%, 28% 30%, 24% 100%, 20% 30%, 16% 100%, 12% 30%, 8% 100%, 4% 30%, 0 100%)',
          }}
        />
      </div>
    </figure>
  );
}
