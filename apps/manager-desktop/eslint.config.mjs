import { createRequire } from 'node:module';
import globals from 'globals';

const require = createRequire(import.meta.url);
const { baseConfig } = require('@loyalty-pro/config/eslint');

export default [
  ...baseConfig({ ignores: ['dist/**', 'src-tauri/target/**'] }),
  {
    files: ['**/*.tsx', '**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
];
