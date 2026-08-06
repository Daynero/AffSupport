import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Soty production boundary', () => {
  it('does not alter production build/deploy/package commands', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    for (const name of ['build', 'build:web', 'deploy:web', 'package:mac', 'package:dmg'])
      expect(scripts[name]).not.toContain('soty-review');
  });

  it('does not appear in a production web build when present', () => {
    if (!existsSync('apps/web/dist')) return;
    const names = readdirSync('apps/web/dist', { recursive: true }).map(String);
    expect(names.some(name => /soty-review/i.test(name))).toBe(false);
  });
});
