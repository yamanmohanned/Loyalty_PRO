/**
 * Runs the Google stand-in on its own, for walking the Drive flow against a scratch
 * service by hand (NODE_ENV=test honours the endpoint overrides; production never does).
 *
 *   pnpm --filter @walaa/api exec tsx src/__tests__/helpers/serve-fake-google.ts 47100
 */
import { startFakeGoogle } from './fake-google';

const port = Number(process.argv[2] ?? 47100);
const google = await startFakeGoogle({ port });
process.stdout.write(`fake Google listening on ${google.origin}\n`);
