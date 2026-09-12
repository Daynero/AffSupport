import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One list of browser origins, not one per function.
 *
 * `_shared/cors.ts` learned about the installed Agent's own origin — it serves
 * the same authenticated UI on 43120 and calls Edge Functions directly — and
 * every function that imports it got the fix. `issue-agent-token` kept a private
 * copy of the allow-list, so pairing went on answering 403 to the very
 * application it exists to pair, and redeploying it changed nothing, because
 * nothing about it was stale. It was duplicated.
 *
 * That failure is invisible in review (the copy looks correct where it sits) and
 * invisible in deployment (the function is at HEAD). It is only visible as a
 * rule.
 */

const ROOT = path.resolve('supabase/functions');

function functionSources() {
  return readdirSync(ROOT)
    .filter(name => name !== '_shared' && statSync(path.join(ROOT, name)).isDirectory())
    .map(name => {
      const directory = path.join(ROOT, name);
      const files = readdirSync(directory).filter(entry => entry.endsWith('.ts'));
      return {
        name,
        text: files.map(entry => readFileSync(path.join(directory, entry), 'utf8')).join('\n')
      };
    });
}

/**
 * Only the functions that answer a browser. The workers and the OAuth redirect
 * emit no CORS header and have no allow-list to get wrong, so enumerating them
 * here and skipping them inside would report checks that never ran.
 */
function browserFacing() {
  return functionSources().filter(entry => entry.text.includes('access-control-allow-origin'));
}

describe('every Edge Function that answers a browser', () => {
  it('has functions to check at all', () => {
    expect(functionSources().length).toBeGreaterThan(5);
    expect(browserFacing().length).toBeGreaterThan(0);
  });

  it.each(browserFacing())('takes its allowed origins from the shared list: $name', ({ text }) => {
    expect(text).toMatch(/from '\.\.\/_shared\/cors\.ts'/u);
  });

  it.each(browserFacing())('does not enumerate its own local origins: $name', ({ text }) => {
    // Only about code: a default for WISHLY_SITE_URL is a fallback, not an
    // allow-list, and four functions legitimately carry one. What must not exist
    // is a second place deciding which origins are allowed.
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ');
    const enumerated = [...code.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/gu)].map(
      match => match[0]
    );
    expect(enumerated).toEqual([]);
  });

  it('keeps the installed and beta Agent origins in the shared list', () => {
    // The desktop app serves this UI on 43120, the isolated beta Agent on 43140.
    // Losing either turns every call those UIs make into "Origin not allowed".
    const shared = readFileSync(path.join(ROOT, '_shared/cors.ts'), 'utf8');
    for (const origin of [
      'http://127.0.0.1:5173',
      'http://127.0.0.1:43120',
      'http://127.0.0.1:43140'
    ])
      expect(shared).toContain(origin);
  });
});
