import { createRequire } from 'node:module';
import globals from 'globals';

const require = createRequire(import.meta.url);
const { baseConfig } = require('@walaa/config/eslint');

export default [
  ...baseConfig({ ignores: ['.next/**', 'next-env.d.ts'] }),
  {
    files: ['**/*.tsx', '**/*.ts'],
    languageOptions: { globals: { ...globals.browser, React: 'readonly' } },
  },
];
