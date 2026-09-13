/**
 * The design system's fence (021, T010).
 *
 * Soty grew four button languages, three panel languages and seventeen ad-hoc
 * type steps because nothing ever said no. The token layer answers "what value
 * should this be"; this check answers "did anyone go around it".
 *
 * It fails on a raw colour, duration, radius or font size outside the token
 * layer, and on a transition of a property that cannot be composited. The
 * allow-list carries what exists on the day it lands and must shrink to empty
 * before the feature closes (T151) — an exemption is a debt, recorded with a
 * reason, not a permission.
 *
 * Exit code 1 on any violation, so `npm run verify` fails with it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STYLE_ROOT = path.join(ROOT, 'apps/web/src');
/** The one file allowed to hold raw values. */
const TOKEN_FILE = path.join(STYLE_ROOT, 'styles/tokens.css');
const ALLOW_FILE = path.join(ROOT, 'config/design-token-exemptions.json');

/** Properties a transition may name: none of them force layout. */
const COMPOSITABLE = new Set([
  'transform',
  'opacity',
  'filter',
  'backdrop-filter',
  'color',
  'background-color',
  'background',
  'border-color',
  'box-shadow',
  'fill',
  'stroke',
  'outline-color',
  'text-decoration-color',
  'none',
  'all'
]);

const RULES = [
  {
    id: 'raw-colour',
    // #abc, #aabbcc, rgb(...), hsl(...) — but not inside a var() fallback chain,
    // which cannot be expressed in one pattern and is caught by review instead.
    pattern: /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi,
    message: 'raw colour — use a --color-* role from styles/tokens.css'
  },
  {
    id: 'raw-duration',
    pattern: /(?<![\w-])\d+(?:\.\d+)?m?s(?![\w-])/g,
    message: 'raw duration — use --motion-fast/base/slow'
  },
  {
    id: 'raw-radius',
    pattern: /border-radius:\s*[^;v]*\d/g,
    message: 'raw radius — use --radius-sm/md/lg/xl/full'
  },
  {
    id: 'raw-font-size',
    pattern: /font-size:\s*[^;v]*\d/g,
    message: 'raw font size — use a --text-* step'
  }
];

function loadAllowList() {
  if (!existsSync(ALLOW_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(ALLOW_FILE, 'utf8'));
    return Array.isArray(parsed.exemptions) ? parsed.exemptions : [];
  } catch {
    process.stderr.write(`Could not read ${path.relative(ROOT, ALLOW_FILE)}; treating it as empty.\n`);
    return [];
  }
}

/** An exemption matches a file (or a prefix of one) and a rule. */
function exempt(allowList, file, ruleId) {
  return allowList.some(
    entry => ruleId === entry.rule && (file === entry.file || file.startsWith(entry.file))
  );
}

async function stylesheets(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await stylesheets(full)));
    else if (entry.name.endsWith('.css') && full !== TOKEN_FILE) found.push(full);
  }
  return found;
}

/** Strips comments so a value quoted in prose is not reported as a violation. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
}

function checkTransitions(line, relative, lineNumber, violations) {
  const match = /transition(?:-property)?:\s*([^;]+)/.exec(line);
  if (!match) return;
  for (const part of match[1].split(',')) {
    const property = part.trim().split(/\s+/)[0];
    if (!property || property.startsWith('var(')) continue;
    if (!COMPOSITABLE.has(property)) {
      violations.push({
        file: relative,
        line: lineNumber,
        rule: 'layout-transition',
        message: `transition on \`${property}\` — only compositable properties may animate`,
        text: line.trim()
      });
    }
  }
}

async function main() {
  const allowList = loadAllowList();
  const files = await stylesheets(STYLE_ROOT);
  const violations = [];

  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const lines = withoutComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      for (const rule of RULES) {
        if (exempt(allowList, relative, rule.id)) continue;
        rule.pattern.lastIndex = 0;
        const found = line.match(rule.pattern);
        if (!found) continue;
        violations.push({
          file: relative,
          line: lineNumber,
          rule: rule.id,
          message: `${rule.message} (found \`${found[0]}\`)`,
          text: line.trim()
        });
      }
      if (!exempt(allowList, relative, 'layout-transition')) {
        checkTransitions(line, relative, lineNumber, violations);
      }
    });
  }

  if (violations.length === 0) {
    const exemptions = allowList.length;
    process.stdout.write(
      `Design tokens: clean across ${files.length} stylesheets` +
        (exemptions > 0 ? `, with ${exemptions} exemption(s) still outstanding.\n` : '.\n')
    );
    process.exit(0);
  }

  // Grouped by file, because a migration fixes one file at a time.
  const byFile = new Map();
  for (const violation of violations) {
    if (!byFile.has(violation.file)) byFile.set(violation.file, []);
    byFile.get(violation.file).push(violation);
  }
  for (const [file, entries] of byFile) {
    process.stdout.write(`\n${file} — ${entries.length} violation(s)\n`);
    for (const entry of entries.slice(0, 20)) {
      process.stdout.write(`  ${entry.line}: ${entry.message}\n      ${entry.text}\n`);
    }
    if (entries.length > 20) process.stdout.write(`  … and ${entries.length - 20} more\n`);
  }
  process.stdout.write(
    `\n${violations.length} violation(s). Either use a token, or add an exemption with a ` +
      `reason to ${path.relative(ROOT, ALLOW_FILE)} — the exemption list must be empty ` +
      `before 021 closes.\n`
  );
  process.exit(1);
}

await main();
