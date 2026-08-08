import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      'node_modules/**',
      'release/**',
      'coverage/**',
      '**/*.min.js'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: [
      'scripts/**/*.{js,mjs}',
      'apps/soty-review/scripts/**/*.{js,mjs}',
      'apps/web/scripts/**/*.{js,mjs}',
      'apps/web/_shot_tmp.mjs'
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    }
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: ['apps/soty-review/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/web/**', '../../web/**', '../../../web/**'],
              message: 'Soty review must not import production web code.'
            },
            {
              group: ['@video-compressor/shared', '@supabase/**'],
              message: 'Soty review is fixture-only.'
            }
          ]
        }
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Soty review cannot perform network requests.' },
        { name: 'XMLHttpRequest', message: 'Soty review cannot perform network requests.' },
        { name: 'WebSocket', message: 'Application WebSockets are forbidden.' },
        { name: 'EventSource', message: 'Application event streams are forbidden.' },
        { name: 'localStorage', message: 'Review state belongs in the URL.' },
        { name: 'sessionStorage', message: 'Review state belongs in the URL.' },
        { name: 'indexedDB', message: 'Review data must remain immutable fixtures.' }
      ]
    }
  }
);
