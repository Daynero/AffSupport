// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContextOverride } from '../apps/web/src/auth/AuthContext';
import { analytics } from '../apps/web/src/analytics/service';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { CreateSpaceWizard } from '../apps/web/src/team/create/CreateSpaceWizard';
import { makeClient } from './team-space-fixtures';
import { adminAuthStub } from './support/auth-stub';

/**
 * 031 US6 scenario 4 (T006): a wizard that renders again — a prop changes, a keystroke lands
 * in the name field — is still one onboarding flow, so exactly one `team_onboarding_started`.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function wizard(onCancel: () => void) {
  return (
    <AuthContextOverride value={adminAuthStub()}>
      <TeamProvider realtime={false}>
        <CreateSpaceWizard
          client={makeClient()}
          resumeTeamId={null}
          onCancel={onCancel}
          onCreated={() => {}}
        />
      </TeamProvider>
    </AuthContextOverride>
  );
}

describe('create space wizard · onboarding flow', () => {
  it('emits one team_onboarding_started however often the wizard re-renders', () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    const view = render(wizard(() => {}));
    view.rerender(wizard(() => {}));
    view.rerender(wizard(() => {}));
    const field = screen.getByLabelText(/Space name/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Media buyers' } });
    fireEvent.change(field, { target: { value: 'Media buyers 2' } });

    const starts = track.mock.calls.filter(([name]) => name === 'team_onboarding_started');
    expect(starts).toHaveLength(1);
    expect(starts[0]![1]).toEqual({ flow_id: expect.any(String) });
  });

  it('starts a new flow for a new mount', () => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    render(wizard(() => {})).unmount();
    render(wizard(() => {}));
    const flows = track.mock.calls
      .filter(([name]) => name === 'team_onboarding_started')
      .map(([, properties]) => (properties as { flow_id: string }).flow_id);
    expect(flows).toHaveLength(2);
    expect(new Set(flows).size).toBe(2);
  });
});
