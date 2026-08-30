/**
 * @walaa/shared-types — the single definition of every cross-app contract (v3).
 *
 * Imported by the API service, the Manager Desktop app, the Loyalty Station, and
 * (over HTTP) the Print Capture Agent. Nothing in here may be duplicated into an app.
 *
 * Under SQLite these Zod schemas are also the ONLY enum enforcement — the database
 * stores plain strings and will not object to a wrong one. See enums.ts.
 */

export * from './auth';
export * from './barcode';
export * from './card';
export * from './customer';
export * from './discount';
export * from './enums';
export * from './errors';
export * from './invoice';
export * from './invoice-parsers';
export * from './money';
export * from './period';
export * from './phone';
export * from './storage';
export * from './sync';
export * from './transaction';
export * from './voucher';
