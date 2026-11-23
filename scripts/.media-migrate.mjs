// Temporary (070 T003): rewrites @media widths to the five steps of R4 and
// prints a JSON record per condition. Deleted after the migration.
import { readFileSync, writeFileSync } from 'node:fs';
import postcss from 'postcss';

const step = v => (v <= 520 ? 480 : v < 660 ? 640 : v <= 840 ? 768 : v <= 1060 ? 1024 : 1280);
const [file, mode] = process.argv.slice(2);
const source = readFileSync(file, 'utf8');
const root = postcss.parse(source, { from: file });
const lines = source.split('\n');
const records = [];
root.walkAtRules('media', rule => {
  if (!/width/.test(rule.params)) return;
  const before = rule.params;
  const after = before
    .replace(/\(\s*max-width:\s*(\d+)px\s*\)/g, (_, v) => `(max-width: ${step(Number(v))}px)`)
    .replace(/\(\s*min-width:\s*(\d+)px\s*\)/g, (_, v) => `(width > ${step(Number(v) - 1)}px)`);
  const selectors = [];
  rule.walkRules(r => {
    if (selectors.length < 4) selectors.push(r.selector.split(',')[0].trim().replace(/\s+/g, ' '));
  });
  const line = rule.source.start.line;
  records.push({ file, line, before, after, selectors });
  if (before !== after) {
    const index = line - 1;
    if (!lines[index].includes(before)) throw new Error(`${file}:${line} params not on the line`);
    lines[index] = lines[index].replace(before, after);
  }
});
if (mode === 'write') writeFileSync(file, lines.join('\n'));
process.stdout.write(JSON.stringify(records) + '\n');
