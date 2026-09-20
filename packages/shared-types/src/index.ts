/**
 * @loyalty-pro/shared-types — the single definition of every cross-app contract (v3).
 *
 * Imported by the API service, the Manager Desktop app, the Loyalty Station, and
 * (over HTTP) the Print Capture Agent. Nothing in here may be duplicated into an app.
 *
 * Under SQLite these Zod schemas are also the ONLY enum enforcement — the database
 * stores plain strings and will not object to a wrong one. See enums.ts.
 */

export * from './messages';
export * from './auth';
export * from './backup';
export * from './backup-drive';
export * from './barcode';
export * from './card';
export * from './card-stock';
export * from './customer';
export * from './discount';
export * from './enums';
export * from './errors';
export * from './invoice';
export * from './invoice-parsers';
export * from './license';
export * from './money';
export * from './period';
export * from './phone';
export * from './reports';
export * from './settings';
export * from './storage';
export * from './sync';
export * from './transaction';
export * from './voucher';

/*
  The Arabic error map is installed as a side effect of importing this package.

  Every app in this product imports it for its schemas, so this is the one place that
  cannot be forgotten — and forgetting it would put Zod's English defaults back in
  front of a shop owner. See `messages.ts` for the 136 that were there before.
*/
import { installArabicErrorMap } from './messages';
installArabicErrorMap();
