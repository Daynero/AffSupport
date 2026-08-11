import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('Soty review isolation boundary', () => {
  const source = files('apps/soty-review/src')
    .filter(path => /\.tsx?$/.test(path))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n');

  it('has no production, Supabase, shared, analytics or agent imports', () => {
    expect(source).not.toMatch(
      /apps\/web|@supabase|@video-compressor\/shared|analytics\/|api\/client|AgentContext|TeamContext/
    );
  });

  it('has no network, persistent storage or native file calls', () => {
    expect(source).not.toMatch(
      /\bfetch\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)|sendBeacon\s*\(|\b(localStorage|sessionStorage|indexedDB)\b|showOpenFilePicker/
    );
  });

  it('keeps production scripts independent', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['build:web']).not.toContain('soty-review');
    expect(pkg.scripts['deploy:web']).not.toContain('soty-review');
    expect(pkg.scripts.build).not.toContain('soty-review');
  });
});
