import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The origin this policy protects stores the local app's session token in
 * browser storage, beside the account session. A script injected into that page
 * reads the token and gains file access on every paired machine — which is why
 * this is the cheapest high-impact change in the feature, and why getting it
 * wrong is expensive in the other direction: a policy mistake is invisible to
 * every other test and total in production. The page simply stops working, for
 * everyone, at once.
 *
 * So the assertions below are split between "the dangerous thing is forbidden"
 * and "the necessary thing is allowed", and the second half is the one that
 * catches the outage.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headers = readFileSync(path.join(root, 'apps/web/public/_headers'), 'utf8');
const policy = /Content-Security-Policy:\s*(.+)/u.exec(headers)?.[1] ?? '';

function directive(name: string): string {
  const found = policy.split(';').find(part => part.trim().startsWith(`${name} `));
  return found?.trim() ?? '';
}

describe('the content policy', () => {
  it('exists at all', () => {
    // A guard on the guard: an empty policy would make every assertion below
    // vacuously pass.
    expect(policy.length).toBeGreaterThan(100);
  });

  it('allows no inline script beyond the two hashed blocks', () => {
    const script = directive('script-src');
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    // Two hashes, because there are two inline blocks; a third appearing
    // without a matching hash is a page that refuses to run its own script.
    expect([...script.matchAll(/'sha256-/gu)]).toHaveLength(2);
  });

  it('matches the scripts actually in the document', () => {
    // The hashes are generated from index.html, so an edit to either block
    // without regeneration must fail here rather than in a browser.
    execFileSync('node', [path.join(root, 'scripts/generate-csp-headers.mjs'), '--check'], {
      cwd: root,
      stdio: 'pipe'
    });
  });

  it('is deterministic when production variables are exported', () => {
    execFileSync('node', [path.join(root, 'scripts/generate-csp-headers.mjs'), '--check'], {
      cwd: root,
      env: {
        ...process.env,
        VITE_SUPABASE_URL: 'https://example.supabase.co'
      },
      stdio: 'pipe'
    });
  });

  it('forbids framing, base rewriting, plugins and form posts', () => {
    expect(directive('frame-ancestors')).toContain("'none'");
    expect(directive('base-uri')).toContain("'none'");
    expect(directive('object-src')).toContain("'none'");
    expect(directive('form-action')).toContain("'none'");
  });

  it('still allows everything the application needs', () => {
    // The half that prevents an outage. Each entry here corresponds to a thing
    // the app genuinely does, and removing any one of them breaks a feature
    // that no unit test exercises.
    expect(directive('connect-src')).toContain('supabase.co');
    // The local app binds a different port in production, beta and development,
    // so the entry has to cover the loopback host across ports.
    expect(directive('connect-src')).toMatch(/127\.0\.0\.1:\*/u);
    // The re-pairing handshake is a frame served by the local app.
    expect(directive('frame-src')).toMatch(/127\.0\.0\.1:\*/u);
    // An inline SVG in the stylesheet, and a generated download preview.
    expect(directive('img-src')).toContain('data:');
    expect(directive('img-src')).toContain('blob:');
  });

  it('does not set the embedder policy', () => {
    // Deliberate: it would break the loopback handshake frame and cross-origin
    // avatars, both of which are load-bearing.
    expect(headers).not.toContain('Cross-Origin-Embedder-Policy');
  });

  it('asks for HSTS without preloading yet', () => {
    // Preload is irreversible in practice, so it is a decision to take
    // deliberately rather than a default to inherit from a header snippet.
    expect(headers).toContain('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    expect(headers).not.toContain('preload');
  });

  it('sends the other origin headers', () => {
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(headers).toContain('Permissions-Policy:');
  });
});

describe('the document the policy covers', () => {
  const html = readFileSync(path.join(root, 'apps/web/index.html'), 'utf8');

  it('carries no inline event handler or style attribute', () => {
    // Neither is covered by a script hash, so both would be blocked — and the
    // block that would have broken is the boot-recovery screen, whose entire
    // job is to be the thing that still works when everything else failed.
    const markup = html.replace(/\/\/[^\n]*/gu, '');
    expect(markup).not.toMatch(/\son[a-z]+\s*=\s*["']/u);
    expect(markup).not.toMatch(/\sstyle\s*=\s*["']/u);
  });
});
