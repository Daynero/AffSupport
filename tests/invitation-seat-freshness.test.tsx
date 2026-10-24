// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamTariff } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import {
  InvitationPanel,
  type InvitationPanelClient
} from '../apps/web/src/team/members/InvitationPanel';
afterEach(cleanup);
const tariff = (used: number): TeamTariff => ({
  state: 'active',
  planCode: 'lead',
  planNameUk: 'Лід',
  planNameEn: 'Lead',
  seatsTotal: 3,
  seatsUsed: used,
  pendingInvites: 0,
  canInvite: true,
  endsOn: '2026-12-01',
  endsAt: '2026-12-01T21:59:59Z',
  graceUntil: null,
  daysLeft: 30,
  isOwner: true,
  updaterPausedByTariff: false
});
function clientWithOldRead() {
  let resolve!: (value: TeamTariff) => void;
  let reject!: (reason: Error) => void;
  const old = new Promise<TeamTariff>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const client: InvitationPanelClient = {
    listInvitations: vi.fn().mockResolvedValue([]),
    createInvitation: vi.fn(),
    getTeamTariff: vi.fn().mockReturnValueOnce(old).mockResolvedValue(tariff(3))
  };
  return { client, resolve, reject };
}
const tree = (client: InvitationPanelClient, revision = 0, teamId = 'team-a') => (
  <ToastProvider>
    <InvitationPanel teamId={teamId} client={client} canManage revision={revision} />
  </ToastProvider>
);
for (const older of ['success', 'failure'] as const) {
  it(`does not replace newer authoritative seats with an older ${older}`, async () => {
    const { client, resolve, reject } = clientWithOldRead();
    const view = render(tree(client));
    await waitFor(() => expect(client.getTeamTariff).toHaveBeenCalledOnce());
    view.rerender(tree(client, 1));
    await screen.findByText('Seats: 3 of 3');
    await act(async () => {
      if (older === 'success') resolve(tariff(2));
      else reject(new Error('older request lost'));
    });
    expect(screen.getByText('Seats: 3 of 3')).toBeTruthy();
    expect(screen.queryByText('Seats: 2 of 3')).toBeNull();
  });
}
it('does not display the previous space seats while the next space read is pending', async () => {
  const next = new Promise<TeamTariff>(() => {});
  const client: InvitationPanelClient = {
    listInvitations: vi.fn().mockResolvedValue([]),
    createInvitation: vi.fn(),
    getTeamTariff: vi.fn().mockResolvedValueOnce(tariff(2)).mockReturnValue(next)
  };
  const view = render(tree(client));
  await screen.findByText('Seats: 2 of 3');
  view.rerender(tree(client, 0, 'team-b'));
  expect(screen.queryByText('Seats: 2 of 3')).toBeNull();
});
