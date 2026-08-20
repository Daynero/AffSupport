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
    // Every OS-specific mechanism the agent relies on must be reachable only
    // through the platform layer, so a tool is written once and works on both
    // platforms. Without this rule the intent lived only in a doc comment, and
    // route guards had already drifted to hard-coded `darwin` checks that
    // disabled working Windows code paths.
    files: ['apps/agent/src/**/*.ts'],
    ignores: [
      // The platform layer itself, and the native file/folder dialogs, which are
      // the platform implementation of the pickers (osascript vs PowerShell).
      'apps/agent/src/platform/**/*.ts',
      'apps/agent/src/files/picker.ts'
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name=/^(platform|arch)$/]",
          message:
            'Read the host platform through apps/agent/src/platform/platform.ts (capabilities(), currentPlatform(), executableName(), …) so tools stay portable.'
        }
      ]
    }
  },
  {
    // Every heavy child process must go through the shared resource budget, so
    // a power limit covers all local tools at once and a tool added later is
    // covered by default rather than by remembering. Without this the intent
    // would live only in a doc comment, and the twenty-first spawn site would
    // silently escape the ceiling.
    files: ['apps/agent/src/**/*.ts'],
    ignores: [
      // The platform layer and the power module implement the mechanism.
      'apps/agent/src/platform/**/*.ts',
      'apps/agent/src/power/**/*.ts',
      // Sub-second probes and native dialogs: managing them would cost more
      // than it saves, and they are not sustained work.
      'apps/agent/src/ffmpeg/tools.ts',
      'apps/agent/src/whisper/tools.ts',
      'apps/agent/src/files/picker.ts',
      'apps/agent/src/files/dropped-source.ts'
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              // Type-only imports are fine: the compressor queue holds a
              // ChildProcessWithoutNullStreams reference without spawning one.
              allowTypeImports: true,
              message:
                'Spawn heavy children through apps/agent/src/power/spawn.ts (spawnManaged/spawnTracked) so every local tool shares one resource budget.'
            }
          ]
        }
      ]
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
