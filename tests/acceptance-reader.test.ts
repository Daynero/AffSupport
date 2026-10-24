import { describe, expect, it } from 'vitest';
import { diagnosticRoleSafe } from '../scripts/acceptance/diagnostics.mjs';
const attributes = {
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolbypassrls: false,
  rolreplication: false,
  rolcanlogin: true,
  rolconnlimit: 4,
  rolconfig: ['default_transaction_read_only=on', 'statement_timeout=30s']
};
const memberships = [{ rolname: 'wishly_analytics_ro', admin_option: false }];
describe('reuse of a local diagnostic reader', () => {
  it('accepts only the bounded canonical SELECT identity', () => {
    expect(diagnosticRoleSafe(attributes, memberships)).toBe(true);
  });
  it('rejects elevated attributes, altered defaults and additional memberships', () => {
    for (const key of [
      'rolsuper',
      'rolcreatedb',
      'rolcreaterole',
      'rolbypassrls',
      'rolreplication'
    ])
      expect(diagnosticRoleSafe({ ...attributes, [key]: true }, memberships)).toBe(false);
    for (const patch of [
      { rolcanlogin: false },
      { rolconnlimit: -1 },
      { rolconfig: [] },
      { rolconfig: [...attributes.rolconfig, 'search_path=public'] }
    ])
      expect(diagnosticRoleSafe({ ...attributes, ...patch }, memberships)).toBe(false);
    expect(
      diagnosticRoleSafe(attributes, [...memberships, { rolname: 'postgres', admin_option: false }])
    ).toBe(false);
    expect(diagnosticRoleSafe(attributes, [{ ...memberships[0], admin_option: true }])).toBe(false);
    expect(diagnosticRoleSafe(undefined, memberships)).toBe(false);
  });
});
