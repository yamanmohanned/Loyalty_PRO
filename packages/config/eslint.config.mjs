import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseConfig } = require('@loyalty-pro/config/eslint');

export default baseConfig();
