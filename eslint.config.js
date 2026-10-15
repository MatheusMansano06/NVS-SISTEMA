import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', crypto: 'readonly' } },
  },
  {
    // extensão do Chrome: JS puro rodando no navegador
    files: ['extension/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { chrome: 'readonly', document: 'readonly', location: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', MutationObserver: 'readonly', IntersectionObserver: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    // Fronteira de módulos: um módulo só importa outro pelo seu index.ts (API pública).
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../../*/domain/**',
                '../../*/application/**',
                '../../*/infrastructure/**',
                '../../*/presentation/**',
                '../../../modules/**',
              ],
              message: 'Importe outros módulos apenas via seu index.ts (API pública).',
            },
          ],
        },
      ],
    },
  },
);
