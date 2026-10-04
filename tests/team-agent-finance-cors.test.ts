import { expect, it } from 'vitest';
import { corsHeadersForRequest } from '../supabase/functions/_shared/cors';
it('permits only the documented beta web origins, not arbitrary local ports', () => {
  for (const origin of ['http://127.0.0.1:5175', 'http://localhost:5175'])
    expect(
      corsHeadersForRequest(
        new Request('https://api.soty.test', { headers: { origin } }),
        'https://soty.test'
      )?.['access-control-allow-origin']
    ).toBe(origin);
  expect(
    corsHeadersForRequest(
      new Request('https://api.soty.test', { headers: { origin: 'http://127.0.0.1:5174' } }),
      'https://soty.test'
    )
  ).toBe(null);
  expect(
    corsHeadersForRequest(
      new Request('https://api.soty.test', { headers: { origin: 'https://untrusted.test' } }),
      'https://soty.test'
    )
  ).toBe(null);
});
