import { readFileSync, writeFileSync } from 'node:fs';

const [templatePath, outputPath, ...pairs] = process.argv.slice(2);
if (!templatePath || !outputPath || pairs.some(pair => !pair.includes('='))) {
  process.stderr.write('Usage: render-launcher.mjs TEMPLATE OUTPUT TOKEN=value ...\n');
  process.exit(2);
}

let source = readFileSync(templatePath, 'utf8');
for (const pair of pairs) {
  const separator = pair.indexOf('=');
  const token = pair.slice(0, separator);
  const value = pair.slice(separator + 1).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const placeholder = `__${token}__`;
  if (!source.includes(placeholder)) {
    process.stderr.write(`Launcher template is missing ${placeholder}\n`);
    process.exit(1);
  }
  source = source.replaceAll(placeholder, value);
}

const unresolved = source.match(/__[A-Z0-9_]+__/g);
if (unresolved) {
  process.stderr.write(`Unresolved launcher placeholders: ${[...new Set(unresolved)].join(', ')}\n`);
  process.exit(1);
}
writeFileSync(outputPath, source);
