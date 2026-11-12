import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MACOS_FORBIDDEN_ENTITLEMENTS } from '../scripts/verify-macos-release-trust.mjs';

/**
 * 048 FR-002 (T016). The closed entitlement policy is written down in places that cannot
 * share a module — the zsh signing chain, the release gate, the chain's own test — and in
 * the profile plists the chain signs with. This is the one test that reads all of them and
 * refuses to let any copy drift from the others. It reads files only, so it runs on every
 * platform the suite does.
 */

const read = async (relative: string) =>
  (await readFile(path.resolve(relative), 'utf8')).replace(/\r\n/gu, '\n');

const JIT_PAIR = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory'
];

/** `name=(\n  a\n  b\n)` in zsh. */
function zshArray(source: string, name: string): string[] {
  const match = source.match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)\\n\\)`, 'mu'));
  if (!match) throw new Error(`${name} not found`);
  return match[1]!
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/** `const NAME = [\n  'a',\n  'b'\n]` in TypeScript, up to the first closing bracket. */
function tsStringArray(source: string, name: string): string[] {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`, 'u'));
  if (!match) throw new Error(`${name} not found`);
  return [...match[1]!.matchAll(/'([^']+)'/gu)].map(found => found[1]!);
}

function plistKeys(xml: string): string[] {
  return [...xml.matchAll(/<key>([^<]+)<\/key>/gu)].map(found => found[1]!).sort();
}

describe('048 entitlement policy is one list, wherever it is written', () => {
  it('names the same four forbidden entitlements in the chain, the gate and the chain test', async () => {
    const chain = await read('scripts/sign-mac-app.sh');
    const chainTest = await read('tests/mac-signing-chain.test.ts');
    const gate = [...MACOS_FORBIDDEN_ENTITLEMENTS];
    expect(gate).toHaveLength(4);
    expect(zshArray(chain, 'forbidden')).toEqual(gate);
    expect(tsStringArray(chainTest, 'FORBIDDEN_ENTITLEMENTS')).toEqual(gate);
    for (const profile of ['launcher', 'node', 'chromium']) {
      const keys = plistKeys(await read(`packaging/macos/entitlements/${profile}.plist`));
      for (const key of gate) expect(keys).not.toContain(key);
    }
  });

  it('grants exactly the measured JIT pair to the node and chromium profiles and nothing to the launcher', async () => {
    const chain = await read('scripts/sign-mac-app.sh');
    const chainTest = await read('tests/mac-signing-chain.test.ts');
    const pair = [...JIT_PAIR].sort();
    const inChain = chain
      .match(/^jit_pair=\$'([^']+)'/mu)?.[1]
      ?.split('\\n')
      .sort();
    expect(inChain).toEqual(pair);
    expect([...tsStringArray(chainTest, 'REQUIRED_JIT_ENTITLEMENTS')].sort()).toEqual(pair);
    expect(plistKeys(await read('packaging/macos/entitlements/node.plist'))).toEqual(pair);
    expect(plistKeys(await read('packaging/macos/entitlements/chromium.plist'))).toEqual(pair);
    expect(plistKeys(await read('packaging/macos/entitlements/launcher.plist'))).toEqual([]);
  });

  it('selects the JIT profiles by the same two path rules in the chain, its test and the contract', async () => {
    const chain = await read('scripts/sign-mac-app.sh');
    const chainTest = await read('tests/mac-signing-chain.test.ts');
    const contract = await read('specs/048-macos-apple-trust/contracts/signing-chain.md');
    expect(chain).toContain('Contents/Resources/runtime/node) print node');
    expect(chain).toContain('*/chrome-headless-shell) print chromium');
    expect(chainTest).toContain("path.join('Contents', 'Resources', 'runtime', 'node')");
    expect(chainTest).toContain("path.basename(binary) === 'chrome-headless-shell'");
    expect(contract).toContain('`Contents/Resources/runtime/node`');
    expect(contract).toContain('`chrome-headless-shell`');
  });
});
