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
  },
  {
    // A skip has to be visible. Fourteen sites across five test files opened with
    // `if (!available) return;` inside the test body, which reports as **passed** —
    // so a runner missing FFmpeg produced a green tick for tests that asserted
    // nothing. `describeRequiring` in tests/support/requires.ts is the replacement:
    // it decides at collection time and names what is absent in the title. Without
    // a rule the pattern comes back the next time someone writes a test that needs
    // a binary, because it is the shortest thing to type.
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      // Three shapes reach a test callback: `it(…)`, `it.only(…)`, and the
      // double-call `it.skipIf(x)(…)`. Missing any one of them leaves the pattern
      // a rename away from being legal again.
      'no-restricted-syntax': [
        'error',
        ...[
          'CallExpression[callee.name=/^(it|test|beforeAll|beforeEach|afterAll|afterEach)$/]',
          'CallExpression[callee.object.name=/^(it|test)$/]',
          'CallExpression[callee.callee.object.name=/^(it|test)$/]'
        ].map(call => ({
          selector: `${call} IfStatement > ReturnStatement.consequent[argument=null]`,
          message:
            'A bare early return inside a test callback reports as passed, not skipped. Declare the requirement with describeRequiring() from tests/support/requires.js so the skip is visible and counted.'
        }))
      ]
    }
  },
  {
    // The machine probe must not be able to agree with the code it is checking.
    //
    // Its whole value is that it reads the operating system with its own flags, its own
    // parser and its own tree walk. One `import { processTableSnapshot }` and the stop test
    // is once again asserting that the agent agrees with itself — which is precisely the
    // weakness (A14) this feature exists to remove. The restriction is doubled by a source
    // scan in tests/machine-probe-independence.test.ts, because a lint rule is only enforced
    // where lint is run.
    files: ['tests/support/machine-probe.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/agent/src/platform/**', '**/apps/agent/src/power/**'],
              message:
                'The machine probe observes the machine independently of the app. Reimplement what it needs here rather than importing the code under test.'
            }
          ]
        }
      ]
    }
  }
);
