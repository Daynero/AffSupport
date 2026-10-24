// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const fake = vi.hoisted(() => ({
  caps: ['team-background-recovery'],
  instance: 'native-a',
  enabled: false,
  read: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn()
}));
vi.mock('../apps/web/src/AgentContext', () => ({
  useOptionalAgent: () => ({
    capabilities: fake.caps,
    lastKnownAgent: { instanceId: fake.instance },
    connection: 'connected'
  })
}));
vi.mock('../apps/web/src/team/TeamContext', () => ({ useTeam: () => ({ can: () => true }) }));
vi.mock('../apps/web/src/api/recovery', () => ({
  backgroundRecoveryStatus: (...args: unknown[]) => fake.read(...args),
  enableBackgroundRecovery: (...args: unknown[]) => fake.enable(...args),
  disableBackgroundRecovery: (...args: unknown[]) => fake.disable(...args),
  retryBackgroundRecovery: vi.fn()
}));
import { BackgroundRecoverySettings } from '../apps/web/src/team/tariffs/BackgroundRecoverySettings';
const TEAM = '34000000-0000-4000-8000-000000000001';
const status = () => ({
  enabled: fake.enabled,
  installationId: TEAM,
  state: 'ready',
  reason: null
});
beforeEach(() => {
  fake.caps = ['team-background-recovery'];
  fake.instance = 'native-a';
  fake.enabled = false;
  fake.read.mockReset();
  fake.enable.mockReset();
  fake.disable.mockReset();
  fake.read.mockImplementation(async () => status());
  fake.disable.mockImplementation(async () => {
    fake.enabled = false;
    return status();
  });
});
afterEach(cleanup);
it('offers upgrade rather than new setup on a legacy native app', async () => {
  render(<BackgroundRecoverySettings teamId={TEAM} />);
  await waitFor(() => expect(fake.read).toHaveBeenCalledWith(TEAM));
  expect(screen.getByText('Connect an updated Soty app to allow background work.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Allow background work' })).toBeNull();
});
it('still lets a legacy app retire an existing registration', async () => {
  fake.enabled = true;
  render(<BackgroundRecoverySettings teamId={TEAM} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off on this computer' }));
  await waitFor(() => expect(fake.disable).toHaveBeenCalledWith(TEAM));
  expect(fake.enable).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Allow background work' })).toBeNull()
  );
});
it('shows the upgrade explanation when a newer app receives the explicit protocol failure', async () => {
  fake.caps.push('team-background-recovery-actor-bound');
  fake.enable.mockRejectedValue(new Error('AGENT_UPDATE_REQUIRED'));
  render(<BackgroundRecoverySettings teamId={TEAM} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Allow background work' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Connect an updated Soty app to allow background work.'
  );
});
it('does not offer setup before current native ownership has been read', async () => {
  fake.caps.push('team-background-recovery-actor-bound');
  let reply!: (value: ReturnType<typeof status>) => void;
  fake.read.mockImplementation(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  render(<BackgroundRecoverySettings teamId={TEAM} />);
  expect(screen.queryByRole('button', { name: 'Allow background work' })).toBeNull();
  fake.enabled = true;
  reply(status());
  expect(await screen.findByRole('button', { name: 'Turn off on this computer' })).toBeTruthy();
});
it('does not carry the previous team ownership into another team pending read', async () => {
  fake.caps.push('team-background-recovery-actor-bound');
  fake.enabled = true;
  const view = render(<BackgroundRecoverySettings teamId={TEAM} />);
  await screen.findByRole('button', { name: 'Turn off on this computer' });
  let reply!: (value: ReturnType<typeof status>) => void;
  fake.read.mockImplementation(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  view.rerender(<BackgroundRecoverySettings teamId="34000000-0000-4000-8000-000000000002" />);
  expect(screen.queryByRole('button', { name: 'Turn off on this computer' })).toBeNull();
  fake.enabled = false;
  reply(status());
  expect(await screen.findByRole('button', { name: 'Allow background work' })).toBeTruthy();
});

it('rereads ownership after the native instance changes even in the same team', async () => {
  fake.caps.push('team-background-recovery-actor-bound');
  fake.enabled = true;
  const view = render(<BackgroundRecoverySettings teamId={TEAM} />);
  await screen.findByRole('button', { name: 'Turn off on this computer' });
  let reply!: (value: ReturnType<typeof status>) => void;
  fake.read.mockImplementation(
    () =>
      new Promise(resolve => {
        reply = resolve;
      })
  );
  fake.instance = 'native-b';
  view.rerender(<BackgroundRecoverySettings teamId={TEAM} />);
  expect(screen.queryByRole('button', { name: 'Turn off on this computer' })).toBeNull();
  fake.enabled = false;
  reply(status());
  expect(await screen.findByRole('button', { name: 'Allow background work' })).toBeTruthy();
});
