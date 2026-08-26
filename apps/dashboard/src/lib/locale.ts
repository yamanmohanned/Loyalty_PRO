/**
 * Arabic UI copy lives in locale files, never scattered through JSX (CLAUDE.md §9).
 * Phases 2 and 3 grow this; Phase 0 establishes the pattern and the shell strings.
 */

export const locale = {
  appName: 'ولاء',
  appTagline: 'منصة ولاء ومكافآت السوبرماركت',
  nav: {
    overview: 'نظرة عامة',
    customers: 'الزبائن',
    rules: 'قواعد الولاء',
    reports: 'التقارير',
    integrations: 'التكاملات',
    settings: 'الإعدادات',
  },
  common: {
    loading: 'جارٍ التحميل',
    currencySuffix: 'د.ع',
  },
} as const;

export type Locale = typeof locale;
