import { createRequire } from 'node:module';
import globals from 'globals';

const require = createRequire(import.meta.url);
const { baseConfig } = require('@walaa/config/eslint');

export default [
  ...baseConfig({ ignores: ['.expo/**'] }),
  {
    files: ['**/*.tsx', '**/*.ts'],
    // React Native supplies console/fetch/setTimeout from its own runtime.
    languageOptions: { globals: { ...globals.browser, __DEV__: 'readonly' } },
  },
];
