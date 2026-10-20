import { describe, expect, it } from 'vitest';
import { publicFunctionEndpoint } from '../supabase/functions/_shared/function-endpoints.js';

const range = (url: string, headers?: HeadersInit) =>
  publicFunctionEndpoint(new Request(url, { headers }), 'drive-transfer/range');

describe('public function endpoints', () => {
  it('advertises the local gateway and restores the prefix stripped by Edge', () => {
    expect(
      range('http://127.0.0.1:8081/drive-ops?ticket=private', {
        'x-forwarded-host': '127.0.0.1',
        'x-forwarded-port': '54321',
        'x-forwarded-proto': 'http'
      })
    ).toBe('http://127.0.0.1:54321/functions/v1/drive-transfer/range');
  });
  it('preserves a forwarded host port instead of the runtime or forwarded port', () => {
    expect(
      range('http://kong:8000/drive-ops/restitch/claim', {
        'x-forwarded-host': 'localhost:54321',
        'x-forwarded-port': '8000',
        'x-forwarded-proto': 'http'
      })
    ).toBe('http://localhost:54321/functions/v1/drive-transfer/range');
  });
  it('uses the externally terminated HTTPS origin in production', () => {
    expect(
      range('http://edge-runtime:8081/drive-ops', {
        'x-forwarded-host': 'project.supabase.co',
        'x-forwarded-proto': 'https'
      })
    ).toBe('https://project.supabase.co/functions/v1/drive-transfer/range');
  });
  it('keeps the existing gateway prefix exactly once and drops operation query parameters', () => {
    expect(
      range('https://project.supabase.co/functions/v1/drive-ops?ticket=private#fragment')
    ).toBe('https://project.supabase.co/functions/v1/drive-transfer/range');
  });
  it('preserves a gateway mount prefix for directly reached installations', () => {
    expect(range('https://example.test/soty/functions/v1/drive-ops')).toBe(
      'https://example.test/soty/functions/v1/drive-transfer/range'
    );
  });
});
