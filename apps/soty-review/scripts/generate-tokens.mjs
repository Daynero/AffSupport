import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceUrl = new URL('../../../specs/003-rebrand-soty-ui/design-tokens.json', import.meta.url);
const outputUrl = new URL('../src/generated/soty-tokens.css', import.meta.url);

export function resolveTokenDocument(document) {
  const leaves = new Map();
  function collect(node, path = []) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if ('$value' in node) leaves.set(path.join('.'), node.$value);
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('$')) collect(value, [...path, key]);
    }
  }
  collect(document);
  const resolving = new Set();
  const resolved = new Map();
  function resolve(key) {
    if (resolved.has(key)) return resolved.get(key);
    if (resolving.has(key)) throw new Error(`Cyclic token alias: ${key}`);
    if (!leaves.has(key)) throw new Error(`Unknown token alias: ${key}`);
    resolving.add(key);
    const raw = leaves.get(key);
    const value =
      typeof raw === 'string' && /^\{[^}]+\}$/.test(raw) ? resolve(raw.slice(1, -1)) : raw;
    resolving.delete(key);
    resolved.set(key, value);
    return value;
  }
  return new Map([...leaves.keys()].map(key => [key, resolve(key)]));
}

function cssName(key) {
  return `--soty-${key
    .replaceAll('.', '-')
    .replaceAll(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()}`;
}

export function renderTokenCss(document, digest) {
  const tokens = resolveTokenDocument(document);
  const primitives = [];
  const light = [];
  const dark = [];
  for (const [key, value] of tokens) {
    if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}){1,2}$/i.test(value)) continue;
    const line = `  ${cssName(key)}: ${value};`;
    if (key.startsWith('semantic.light.') || key.startsWith('components.light.')) light.push(line);
    else if (key.startsWith('semantic.dark.') || key.startsWith('components.dark.'))
      dark.push(line);
    else primitives.push(line);
  }
  return `/* generated from design-tokens.json · sha256:${digest} */\n.soty-review {\n${primitives.join('\n')}\n}\n.soty-review[data-soty-theme='light'] {\n${light.join('\n')}\n}\n.soty-review[data-soty-theme='dark'] {\n${dark.join('\n')}\n}\n`;
}

async function main() {
  const source = await readFile(sourceUrl, 'utf8');
  const document = JSON.parse(source);
  const digest = createHash('sha256').update(source).digest('hex');
  const css = renderTokenCss(document, digest);
  if (process.argv.includes('--check')) {
    const current = await readFile(outputUrl, 'utf8').catch(() => '');
    if (current !== css) throw new Error('Generated Soty tokens are stale. Run the generator.');
  } else {
    await writeFile(outputUrl, css);
    process.stdout.write('Generated Soty review tokens.\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
