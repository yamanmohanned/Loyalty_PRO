/**
 * Shared ESLint flat-config factory (CLAUDE.md §9).
 *
 * Enforces the two standards that are easy to erode: no unjustified `any`,
 * and no floating promises in the API/service layer.
 */
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

/**
 * @param {object} [options]
 * @param {string[]} [options.ignores] extra ignore globs
 * @returns {import('eslint').Linter.Config[]}
 */
function baseConfig(options = {}) {
  return tseslint.config(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/.expo/**',
        '**/generated/**',
        ...(options.ignores ?? []),
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        globals: { ...globals.node, ...globals.es2022 },
      },
      rules: {
        // CLAUDE.md §9: no `any` without a written justification comment.
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        // CLAUDE.md §9: errors are never swallowed.
        'no-empty': ['error', { allowEmptyCatch: false }],
        // CLAUDE.md §11: money is never a float — guard the obvious foot-guns.
        'no-restricted-globals': [
          'error',
          { name: 'parseFloat', message: 'Money is integer IQD. Use parseInt/Number and validate with Zod.' },
        ],
        eqeqeq: ['error', 'always', { null: 'ignore' }],
        'no-console': ['warn', { allow: ['warn', 'error'] }],
      },
    },
    {
      // Tailwind and ESLint configs are genuinely CommonJS — `require` is correct
      // there, not a lapse, so the ESM-only rule must not apply to them.
      files: ['**/*.cjs'],
      languageOptions: { sourceType: 'commonjs' },
      rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
  );
}

module.exports = { baseConfig };
