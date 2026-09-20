import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseConfig } = require('@loyalty-pro/config/eslint');

export default [
  /*
    Scratch experiment drivers.

    Files named with a leading underscore beside this package are one-off harnesses —
    the concurrency runs, the kill-mid-write rounds — kept locally so their commands
    can be re-run, and gitignored so they never reach a commit. Their RESULTS belong in
    a test or a docblock; the harness itself is not product code and holding it to the
    product's rules only produces noise that pushes real errors off the screen.
  */
  { ignores: ['_*.ts', '_*.mjs', 'prisma/_*.ts', 'prisma/_*.mjs'] },
  /*
    The drills print their findings, which is their entire output. `no-console` is right
    for a service whose logging goes through pino and wrong for a command whose contract
    is what it writes to a terminal.
  */
  ...baseConfig(),
  // AFTER `baseConfig`, deliberately: in flat config the later entry wins, and placed
  // before it this override was silently overwritten by the base rule it exists to relax.
  { files: ['drills/**/*.mjs'], rules: { 'no-console': 'off' } },
];
