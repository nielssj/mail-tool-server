import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json'
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // Constructing the bare ImapFlow class reintroduces the late-'error'
    // crash SafeImapFlow guards against (see src/imap/safeImapFlow.ts).
    // Type-only imports of it are fine.
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'imapflow',
              importNames: ['ImapFlow'],
              allowTypeImports: true,
              message:
                'Construct SafeImapFlow (src/imap/safeImapFlow.ts) instead, so a late error after a failed connect() cannot crash the process.'
            }
          ]
        }
      ]
    }
  }
];
