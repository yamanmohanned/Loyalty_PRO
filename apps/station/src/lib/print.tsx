import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Printing to the station's thermal printer (CLAUDE_v3.md §6.3).
 *
 * The browser's own print pipeline drives the printer. That is a deliberate choice
 * over ESC/POS: a web app cannot open a USB device, and asking a shop to install a
 * bridge service beside the station would be a second thing to install, configure
 * and support for no gain. The printer is a normal Windows/Android printer; the
 * print CSS in `globals.css` shapes the page to 80 mm.
 *
 * Content is mounted into `#print-root`, which the print stylesheet is the only
 * thing that makes visible. `window.print()` is called after the browser has had a
 * frame to lay it out — printing in the same tick prints an empty page, and this is
 * the kind of bug that only shows up on the shop's actual printer.
 */

type PrintFn = (content: ReactNode) => void;

const PrintContext = createContext<PrintFn | null>(null);

export function PrintProvider({ children }: { children: ReactNode }): JSX.Element {
  const [content, setContent] = useState<ReactNode>(null);

  const print = useCallback<PrintFn>((next) => {
    setContent(next);
  }, []);

  useEffect(() => {
    if (!content) return;

    // Two frames: one for React to commit the DOM, one for the browser to lay it
    // out and load the fonts the slip is measured in.
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) window.print();
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [content]);

  useEffect(() => {
    // Clearing after the dialog closes keeps the print area empty between jobs, so a
    // stray Ctrl+P can never print the previous customer's slip.
    const clear = (): void => setContent(null);
    window.addEventListener('afterprint', clear);
    return () => window.removeEventListener('afterprint', clear);
  }, []);

  return (
    <PrintContext.Provider value={print}>
      {children}
      {createPortal(
        <div id="print-root" aria-hidden="true">
          {content}
        </div>,
        document.body,
      )}
    </PrintContext.Provider>
  );
}

export function usePrint(): PrintFn {
  const print = useContext(PrintContext);
  if (!print) throw new Error('usePrint must be used inside a PrintProvider');
  return print;
}
