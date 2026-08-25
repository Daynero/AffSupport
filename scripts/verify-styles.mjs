#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Checks the stylesheet against itself and against the components that feed it.
 *
 * The failure this exists for is silent by construction: a `var()` naming a
 * property nobody defined resolves to nothing, and the declaration is simply
 * dropped. No warning, no error — an element renders without its border, or
 * without its background, and looks like a design decision. Eight of those were
 * live when this was written, including a transition that never ran and a
 * dashed border that was never drawn.
 *
 * A property set from JavaScript is not undefined; it is defined somewhere this
 * file has to look, which is why the component tree is scanned too rather than
 * maintaining an allowlist that goes stale.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The stylesheet to check. Overridable by argument so a test can point this at
 * a copy — a test that edits the real file races with anything else reading it,
 * which is not hypothetical: the first version of the test for this checker ran
 * in two vitest projects at once and truncated the stylesheet to two lines.
 */
const STYLESHEET = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'apps/web/src/styles.css');
const WEB_SRC = path.join(root, 'apps/web/src');

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    if (statSync(candidate).isDirectory()) found.push(...sourceFiles(candidate));
    else if (/\.(?:ts|tsx)$/u.test(entry)) found.push(candidate);
  }
  return found;
}

const css = readFileSync(STYLESHEET, 'utf8');

/** Properties declared in the stylesheet. */
const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gmu)].map(match => match[1]));

/** Properties assigned by a component, which are equally defined. */
const fromComponents = new Set();
for (const file of sourceFiles(WEB_SRC)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/['"`](--[a-z0-9-]+)['"`]/gu)) fromComponents.add(match[1]);
  for (const match of source.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)/gu)) {
    fromComponents.add(match[1]);
  }
}

const problems = [];

// 1. A reference with no fallback to a property nothing defines.
for (const match of css.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/gu)) {
  const [, name, fallback] = match;
  if (declared.has(name) || fromComponents.has(name) || fallback) continue;
  problems.push(`${name} is referenced without a fallback and never defined`);
}

// 2. A declared property nothing reads. Not an error — a token can be declared
//    ahead of the code that uses it — but worth counting, because an unread
//    token is usually a rename that only happened on one side.
const referenced = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gu)].map(match => match[1]));
const unread = [...declared].filter(name => !referenced.has(name));

process.stdout.write(
  `styles: ${declared.size} declared, ${referenced.size} referenced, ` +
    `${fromComponents.size} set from components, ${unread.length} unread\n`
);

if (problems.length) {
  for (const problem of [...new Set(problems)]) process.stdout.write(`  ${problem}\n`);
  process.stderr.write(
    'styles: a var() that resolves to nothing drops its declaration silently — ' +
      'define the property, or give the reference a fallback.\n'
  );
  process.exit(1);
}
