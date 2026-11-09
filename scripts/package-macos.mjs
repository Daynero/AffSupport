import { spawnSync } from 'node:child_process';
import { parseMacosTarget } from './lib/macos-target.mjs';

// npm appends arguments to only the last command in an && chain. Validate once,
// then forward the same closed target through every package and verification step.
const [action, ...args] = process.argv.slice(2);
const target = parseMacosTarget(args);
const commands = {
  'dev-dmg': [
    ['zsh', ['scripts/package-dev-mac.sh']],
    ['zsh', ['scripts/package-dev-dmg.sh']],
    ['zsh', ['scripts/verify-dev-package.sh']]
  ],
  'production-dmg': [
    ['node', ['scripts/verify-release.mjs', '--mode=candidate']],
    ['npm', ['run', 'verify:team-production']],
    ['zsh', ['scripts/package-dmg.sh']]
  ],
  production: [
    ['npm', ['run', 'build']],
    ['node', ['scripts/verify-release.mjs', '--mode=candidate']],
    ['npm', ['run', 'verify:team-production']],
    ['node', ['scripts/verify-beta-promotion.mjs']],
    ['zsh', ['scripts/package-mac.sh']]
  ]
};
if (!Object.hasOwn(commands, action)) throw new Error('MACOS_PACKAGE_ACTION_INVALID');
for (const [command, commandArgs] of commands[action]) {
  const forwarded = command === 'zsh' ? [...commandArgs, `--arch=${target.arch}`] : commandArgs;
  const result = spawnSync(command, forwarded, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
