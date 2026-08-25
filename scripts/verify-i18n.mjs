#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finds translation keys that nothing reads, and reads that nothing defines.
 *
 * The obvious version of this scans call sites — `t('someKey')` — and is wrong
 * in the expensive direction: a key assembled at runtime, `t(\`error\${code}\`)`,
 * looks unused and gets deleted, and the string disappears from the product for
 * whichever code path builds that name. So this scans every string literal in
 * the source instead, and subtracts a committed list of the keys that really
 * are built dynamically.
 *
 * The committed list is the honest part. It is small, it is reviewed, and a
 * lint rule keeps it that way by forbidding new dynamic keys — a checker whose
 * exception list grows on its own is a checker that stops meaning anything.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(root, 'apps/web/src/i18n.ts');
const DYNAMIC = path.join(root, 'i18n-dynamic.json');
const SOURCE_ROOTS = [path.join(root, 'apps/web/src')];

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    if (statSync(candidate).isDirectory()) found.push(...sourceFiles(candidate));
    else if (/\.(?:ts|tsx)$/u.test(entry)) found.push(candidate);
  }
  return found;
}

const i18nSource = readFileSync(I18N, 'utf8');

/**
 * Keys declared in the English dictionary.
 *
 * Taken from the first dictionary only: the second is the translation of the
 * same set, and a key present in one and missing from the other is a different
 * problem with a different fix.
 */
const firstDictionary = i18nSource.slice(0, i18nSource.indexOf('const uk'));
const declared = new Set(
  [...firstDictionary.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:/gmu)].map(match => match[1])
);

/** Every string literal anywhere in the interface source. */
const literals = new Set();
for (const directory of SOURCE_ROOTS) {
  for (const file of sourceFiles(directory)) {
    if (file === I18N) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]{2,})['"`]/gu)) {
      literals.add(match[1]);
    }
  }
}

const dynamic = existsSync(DYNAMIC)
  ? new Set(JSON.parse(readFileSync(DYNAMIC, 'utf8')).keys ?? [])
  : new Set();

const unused = [...declared].filter(key => !literals.has(key) && !dynamic.has(key)).sort();
const dynamicButDeclared = [...dynamic].filter(key => declared.has(key));

process.stdout.write(
  `i18n: ${declared.size} keys, ${literals.size} literals scanned, ` +
    `${dynamic.size} declared dynamic, ${unused.length} unused\n`
);

if (process.argv.includes('--list') && unused.length) {
  for (const key of unused) process.stdout.write(`  ${key}\n`);
}

// Reported, not failed. An unused key is dead weight rather than a defect, and
// a gate that fails on one would block a change that adds a string ahead of the
// screen that shows it.
if (dynamicButDeclared.length !== dynamic.size) {
  const missing = [...dynamic].filter(key => !declared.has(key));
  process.stderr.write(
    `i18n: ${missing.length} key(s) listed as dynamic do not exist: ${missing.join(', ')}\n`
  );
  process.exit(1);
}
