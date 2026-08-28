import { createRequire } from 'node:module';
import globals from 'globals';

const require = createRequire(import.meta.url);
const { baseConfig } = require('@walaa/config/eslint');

export default [
  ...baseConfig({ ignores: ['dist/**', 'src-tauri/target/**'] }),
  {
    files: ['**/*.tsx', '**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
];
