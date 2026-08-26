/**
 * @walaa/shared-types — the single definition of every cross-app contract.
 *
 * Imported by apps/api, apps/dashboard and apps/assistant. Nothing in here may be
 * duplicated into an app (CLAUDE.md §2.3, §9).
 */

export * from './auth';
export * from './coupon';
export * from './customer';
export * from './enums';
export * from './errors';
export * from './invoice';
export * from './invoice-parsers';
export * from './money';
export * from './period';
export * from './phone';
export * from './rules';
export * from './sync';
export * from './transaction';
