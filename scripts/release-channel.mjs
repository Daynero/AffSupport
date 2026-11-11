#!/usr/bin/env node
/**
 * Feature 051 — the owner's four release words, as commands.
 *
 *   status                 what is on production, on next, and what a rollback returns to
 *   promote  [--confirm]   ship exactly the build tested on next to everyone
 *   rollback [--confirm]   return production to the previous promoted build
 *   cancel   [--confirm]   show production again on next; the candidate is dropped
 *   adopt-live [--search=<dir>]… [--confirm]
 *                          record what production serves today (first-time setup)
 *
 * Without --confirm nothing is written anywhere; the command says what it would do.
 * --json prints one machine-readable object instead of prose.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeBinding } from './lib/release/bindings.mjs';
import {
  adoptLive,
  cancel,
  describeStatus,
  promote,
  rollback,
  status
} from './lib/release-channel/operations.mjs';
import { channelDirectory } from './lib/release-channel/state.mjs';

const COMMANDS = ['status', 'promote', 'rollback', 'cancel', 'adopt-live'];

/**
 * Every place on this machine a deploy may have left the bytes production
 * serves: the channel archive, and each worktree of this repository -- its
 * legacy `release/automation/bundles` and its built `apps/web/dist`. The
 * runner's temporary worktrees are worktrees too, so they are found the same way.
 */
export function defaultAdoptSearch(root, channelDir) {
  const roots = [path.join(channelDir, 'bundles')];
  let worktrees = [root];
  try {
    worktrees = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      timeout: 10_000
    })
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length));
  } catch {
    /* not a git checkout: search this directory only */
  }
  for (const worktree of worktrees)
    if (existsSync(worktree))
      roots.push(
        path.join(worktree, 'release/automation/bundles'),
        path.join(worktree, 'apps/web/dist')
      );
  return [...new Set(roots.map(entry => path.resolve(entry)))].filter(entry => existsSync(entry));
}

const say = {
  promote: r =>
    r.confirmed
      ? `Готово: ${r.to.version} розкочено на всіх.${r.smoke?.ok === false ? '\nУВАГА: автоматична перевірка живого сайту не пройшла — подивіться вивід вище; якщо щось зламано, виконайте rollback.' : ''}`
      : `${r.summary}.\nЗараз на проді: ${r.from ? r.from.version : 'не записано'}. Next віддає саме цю збірку — перевірено.\nНічого не змінено. Додайте --confirm, щоб розкотити.`,
  rollback: r =>
    r.confirmed
      ? `Готово: прод повернуто на ${r.to.version}. Хто вже встановив новий агент, побачить пропозицію повернутись на стабільну версію.`
      : `${r.summary}.\nНічого не змінено. Додайте --confirm, щоб відкотити.`,
  cancel: r =>
    r.confirmed
      ? `Готово: кандидата ${r.from.version} скасовано, next знову показує ${r.to.version}.`
      : `${r.summary}.\nНічого не змінено. Додайте --confirm, щоб скасувати.`,
  'adopt-live': r =>
    r.confirmed
      ? `Записано: прод зараз ${r.record.version} (бандл ${r.record.outputDigest.slice(0, 12)}); тепер відкат має куди повертатись.`
      : `Знайдено бандл, який зараз віддає прод: ${r.found} (${r.record.version}). Додайте --confirm, щоб записати.`
};

export async function main(argv = process.argv.slice(2), options = {}) {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');
  const confirm = rest.includes('--confirm');
  if (!COMMANDS.includes(command ?? '')) {
    process.stderr.write(
      `Usage: release:channel -- <${COMMANDS.join('|')}> [--confirm] [--json]\n`
    );
    return 2;
  }
  const root = options.root ?? process.cwd();
  const base = { root, binding: options.binding ?? activeBinding(), ...options };
  try {
    let result;
    if (command === 'status') {
      result = await status(base);
      process.stdout.write(
        json
          ? `${JSON.stringify({ ok: true, command, ...result })}\n`
          : `${describeStatus(result)}\n`
      );
      return 0;
    }
    if (command === 'promote') result = await promote(base, { confirm });
    if (command === 'rollback') result = await rollback(base, { confirm });
    if (command === 'cancel') result = await cancel(base, { confirm });
    if (command === 'adopt-live') {
      const dir = await channelDirectory(root);
      const explicit = rest.filter(arg => arg.startsWith('--search=')).map(arg => arg.slice(9));
      result = await adoptLive(base, {
        confirm,
        search: explicit.length ? explicit : defaultAdoptSearch(root, dir)
      });
    }
    process.stdout.write(
      json ? `${JSON.stringify({ ok: true, command, ...result })}\n` : `${say[command](result)}\n`
    );
    return result?.smoke?.ok === false ? 1 : 0;
  } catch (error) {
    const code = /** @type {any} */ (error)?.code ?? 'CHANNEL_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, command, code, message })}\n`);
    else process.stderr.write(`Відмовлено (${command}): ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
