import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeRequiring } from './support/requires.js';
import { webDistBuilt } from './support/toolchain.js';

describe('Soty production boundary', () => {
  it('does not alter production build/deploy/package commands', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    for (const name of ['build', 'build:web', 'deploy:web', 'package:mac', 'package:dmg'])
      expect(scripts[name]).not.toContain('soty-review');
  });
});

describeRequiring(webDistBuilt, 'Soty production boundary in a built bundle', () => {
  it('does not appear in a production web build', () => {
    const names = readdirSync('apps/web/dist', { recursive: true }).map(String);
    expect(names.some(name => /soty-review/i.test(name))).toBe(false);
  });
});
