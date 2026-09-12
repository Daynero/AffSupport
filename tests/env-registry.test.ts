import { describe, expect, it } from 'vitest';
import {
  assertRegistryShape,
  checkFormat,
  compareSurface,
  loadRegistry,
  requiredNames,
  scanUsage,
  validateValues,
  variablesFor
} from '../scripts/lib/env-registry.mjs';

/**
 * The registry only helps if it cannot quietly disagree with the code, so these
 * cover the two ways it could: a scanner that misses a real usage, and a
 * comparison that forgives a difference.
 */
describe('environment registry', () => {
  it('does not mistake the tail of another identifier for a Vite variable', () => {
    // The bug this exists for: `INVITE_TTL_DAYS` ends in `VITE_TTL_DAYS`, and a
    // naive pattern reported a variable that was never read from the env.
    const text =
      'export const TEAM_INVITE_TTL_DAYS = 14;\nconst real = import.meta.env.VITE_SITE_URL;';
    expect([...scanUsage('vite', text)]).toEqual(['VITE_SITE_URL']);
  });

  it('finds Deno secrets however the call is quoted', () => {
    const text = `const a = Deno.env.get('RESEND_API_KEY');\nconst b = Deno.env.get( "WISHLY_SITE_URL" );`;
    expect([...scanUsage('deno', text)].sort()).toEqual(['RESEND_API_KEY', 'WISHLY_SITE_URL']);
  });

  it('reads env-file keys and ignores comments and blank lines', () => {
    const text = '# a comment\n\nPUBLIC_SITE_ORIGIN=https://soty.pp.ua\nAGENT_PORT=43120\n';
    expect([...scanUsage('envfile', text)].sort()).toEqual(['AGENT_PORT', 'PUBLIC_SITE_ORIGIN']);
  });

  it('reports both directions of disagreement', () => {
    const result = compareSurface({
      registered: ['KEPT', 'STALE'],
      used: new Set(['KEPT', 'NEW'])
    });
    expect(result.unregistered).toEqual(['NEW']);
    expect(result.unused).toEqual(['STALE']);
  });

  it('refuses a registry that would silently check nothing', () => {
    expect(() => assertRegistryShape({ surfaces: {}, variables: [] })).toThrow(
      'ENV_REGISTRY_INVALID'
    );
    expect(() =>
      assertRegistryShape({
        surfaces: { web: {} },
        variables: [{ name: 'A', surface: 'nowhere', required: [] }]
      })
    ).toThrow('unknown surface');
    expect(() =>
      assertRegistryShape({
        surfaces: { web: {} },
        variables: [
          { name: 'A', surface: 'web', required: [] },
          { name: 'A', surface: 'web', required: [] }
        ]
      })
    ).toThrow('declared twice');
  });

  it('allows one name on two surfaces, because one of them genuinely is', () => {
    // DRIVE_OAUTH_MODE is both a function secret and packaged agent config.
    expect(() =>
      assertRegistryShape({
        surfaces: { functions: {}, agent: {} },
        variables: [
          { name: 'DRIVE_OAUTH_MODE', surface: 'functions', required: [] },
          { name: 'DRIVE_OAUTH_MODE', surface: 'agent', required: [] }
        ]
      })
    ).not.toThrow();
  });

  it('never demands a value the platform injects', () => {
    const registry = assertRegistryShape({
      surfaces: { functions: {} },
      variables: [
        {
          name: 'SUPABASE_URL',
          surface: 'functions',
          required: ['production'],
          provided: 'platform'
        },
        { name: 'OURS', surface: 'functions', required: ['production'] }
      ]
    });
    expect(requiredNames(registry, 'functions', 'production')).toEqual(['OURS']);
    expect(validateValues(registry, 'functions', 'production', {})).toEqual([
      { name: 'OURS', problem: 'is missing', note: undefined }
    ]);
  });

  it('checks shape only when a value is present', () => {
    const registry = assertRegistryShape({
      surfaces: { web: {} },
      variables: [{ name: 'VITE_OPTIONAL', surface: 'web', required: [], format: 'https-origin' }]
    });
    expect(validateValues(registry, 'web', 'production', {})).toEqual([]);
    expect(
      validateValues(registry, 'web', 'production', { VITE_OPTIONAL: 'http://x.test' })
    ).toEqual([{ name: 'VITE_OPTIONAL', problem: 'is not an https origin', note: undefined }]);
  });

  it('distinguishes an https origin from an https URL', () => {
    expect(checkFormat('https-origin', 'https://soty.pp.ua')).toBeNull();
    expect(checkFormat('https-origin', 'https://soty.pp.ua/auth/callback')).toMatch(
      'not an origin'
    );
    expect(checkFormat('enum:disabled|verified', 'testing')).toMatch('must be one of');
    expect(checkFormat('enum:disabled|verified', 'verified')).toBeNull();
  });

  it('rejects a format nobody defined rather than passing it', () => {
    expect(() => checkFormat('invented', 'x')).toThrow('unknown format');
  });
});

describe('the tracked registry', () => {
  const registry = loadRegistry(process.cwd());

  it('declares every surface the deployment has', () => {
    expect(Object.keys(registry.surfaces).sort()).toEqual(['agent', 'functions', 'web']);
  });

  it('requires the secret whose absence stops every desktop pairing', () => {
    // The gate that guarded production secrets before this registry did not
    // name AGENT_TOKEN_PRIVATE_KEY, so a project without it passed and then
    // answered 503 to every pairing attempt.
    expect(requiredNames(registry, 'functions', 'production')).toContain('AGENT_TOKEN_PRIVATE_KEY');
  });

  it('keeps the entitlement key pair declared together', () => {
    const names = registry.variables.map(entry => entry.name);
    expect(names).toContain('AGENT_TOKEN_PRIVATE_KEY');
    expect(names).toContain('AGENT_ENTITLEMENT_PUBLIC_KEY');
  });

  it('never marks a browser variable secret, because the bundle is public', () => {
    expect(variablesFor(registry, 'web').filter(entry => entry.secret)).toEqual([]);
  });

  it('explains every variable it declares', () => {
    const unexplained = registry.variables
      .filter(entry => !entry.note?.trim())
      .map(entry => entry.name);
    expect(unexplained).toEqual([]);
  });
});
