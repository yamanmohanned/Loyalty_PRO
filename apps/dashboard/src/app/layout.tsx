import type { Metadata, Viewport } from 'next';
import { locale } from '@/lib/locale';
import './globals.css';

/**
 * Root layout.
 *
 * `dir="rtl" lang="ar"` is set here, once, on <html> — RTL is the document's
 * baseline, not a modifier applied per screen (CLAUDE.md §0.3). Every component
 * below this point uses Tailwind's logical utilities (ps-/pe-/ms-/me-/start-/end-)
 * so mirroring is automatic rather than hand-maintained.
 */

export const metadata: Metadata = {
  title: {
    default: `${locale.appName} — لوحة التحكم`,
    template: `%s — ${locale.appName}`,
  },
  description: locale.appTagline,
};

export const viewport: Viewport = {
  themeColor: '#0F6E56',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        {/*
          Cairo · IBM Plex Sans Arabic · IBM Plex Mono (CLAUDE.md §6.3).
          Preconnect so the Arabic faces are not a render-blocking round trip —
          layout space is reserved by the token line-heights, keeping CLS low (§8).
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      {/* min-h-[100dvh], never h-screen (CLAUDE.md §6.5). */}
      <body className="min-h-[100dvh] bg-canvas text-ink">{children}</body>
    </html>
  );
}
