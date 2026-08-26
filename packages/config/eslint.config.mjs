import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseConfig } = require('@walaa/config/eslint');

export default baseConfig();
