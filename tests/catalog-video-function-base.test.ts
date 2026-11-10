import { describe, expect, it } from 'vitest';
import { PRODUCTION_BACKEND_ORIGIN } from '../packages/shared/src/release';
import {
  catalogVideoFunctionBase,
  isCatalogVideoFunctionOrigin
} from '../supabase/functions/_shared/restitch-native.ts';
import { catalogVideoProcessGrants } from '../supabase/functions/drive-ops/catalog-video-process-grants.ts';

// 1.4.1 regression: the server handed production agents the beta loopback
// origin, so every catalog restitch failed locally as PERMISSION_DENIED.
describe('catalog video function base', () => {
  it('gives a production stack the hosted origin and a beta stack its loopback', () => {
    expect(catalogVideoFunctionBase(undefined)).toBe(`${PRODUCTION_BACKEND_ORIGIN}/functions/v1`);
    expect(catalogVideoFunctionBase('production')).toBe(
      `${PRODUCTION_BACKEND_ORIGIN}/functions/v1`
    );
    expect(catalogVideoFunctionBase('beta')).toBe('http://127.0.0.1:54321/functions/v1');
  });

  it('admits only the two known origins for process grants', () => {
    expect(isCatalogVideoFunctionOrigin(PRODUCTION_BACKEND_ORIGIN)).toBe(true);
    expect(isCatalogVideoFunctionOrigin('http://127.0.0.1:54321')).toBe(true);
    expect(isCatalogVideoFunctionOrigin('https://evil.example')).toBe(false);
    const native = {} as Parameters<typeof catalogVideoProcessGrants>[1];
    const service = {} as Parameters<typeof catalogVideoProcessGrants>[0];
    expect(() =>
      catalogVideoProcessGrants(service, native, {
        functionBase: catalogVideoFunctionBase('production'),
        secret: 's'
      })
    ).not.toThrow();
    expect(() =>
      catalogVideoProcessGrants(service, native, {
        functionBase: 'https://evil.example/functions/v1',
        secret: 's'
      })
    ).toThrow();
  });
});
