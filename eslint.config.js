import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'tests/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Mirante never makes outbound network calls. See ADR-0005.' },
      ],
    },
  },
  {
    // The board talks to the daemon that served it, on loopback and same-origin.
    // ADR-0005 forbids leaving the machine, not calling the local daemon.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-globals': 'off' },
  },
  prettier,
);
