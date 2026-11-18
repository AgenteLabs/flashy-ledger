import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Numbers in template literals are idiomatic and safe; the rule's default
      // objection is to objects and nullables, which stay banned.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // The ledger's whole point is that its rules do not depend on I/O. Anything
    // that reaches for a clock, a random source or the network belongs in an
    // adapter, where it can be substituted in a test.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'The domain is pure. Pass occurredAt in from the caller.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'The domain must be deterministic.' },
        { object: 'Date', property: 'now', message: 'The domain is pure. Pass occurredAt in.' },
      ],
    },
  },
  {
    // The dependency-free node --test files (`npm run test:standalone`) are
    // plain ESM outside the TypeScript project. Type-aware rules cannot run
    // over them — the project service refuses a file tsconfig does not
    // include, which is how `npm run lint` was red on
    // tests/cross-linking.test.mjs — so they get the untyped rule set.
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Merged, not replaced: the spread above is what switches the project
      // service off for these files, and a bare `languageOptions` here would
      // silently discard it.
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Test doubles implement async ports without awaiting anything.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-unary-minus': 'off',
    },
  },
)
