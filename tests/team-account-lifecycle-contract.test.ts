import { expect, it } from 'vitest';
import {
  parseTeamAccountArchivePreflight,
  parseTeamAccountNameColorResult
} from '../packages/shared/src/team/account-lifecycle';

it.each(['', '-1', 'NaN', '1.5', 'x', '9'.repeat(20)])(
  'rejects invalid CAS version %s at both lifecycle boundaries',
  version => {
    expect(
      parseTeamAccountArchivePreflight({
        entityId: 'rk',
        entityKind: 'agent',
        lifecycleVersion: version,
        token: 'token',
        archivedAt: null,
        effectiveArchived: false,
        childCount: 0
      })
    ).toBeNull();
    expect(
      parseTeamAccountNameColorResult({
        operationId: 'op',
        requestId: 'request',
        agentId: 'rk',
        color: 1,
        version
      })
    ).toBeNull();
  }
);
it('rejects an invalid archive timestamp before temporal projection', () => {
  expect(
    parseTeamAccountArchivePreflight({
      entityId: 'rk',
      entityKind: 'agent',
      lifecycleVersion: '0',
      token: 'token',
      archivedAt: 'not-a-date',
      effectiveArchived: true,
      childCount: 0
    })
  ).toBeNull();
});
