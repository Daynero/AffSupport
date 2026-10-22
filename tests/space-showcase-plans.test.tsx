// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SpaceAccess } from '@video-compressor/shared';
import { SpaceShowcase } from '../apps/web/src/team/tariffs/SpaceShowcase';
import { ToastProvider } from '../apps/web/src/components/toast';
const track = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track } }));
afterEach(cleanup);
it('defaults to Solo, switches exclusively and prepares the selected price without sending', () => {
  localStorage.setItem('language', 'uk');
  const client = { joinWaitlist: vi.fn().mockResolvedValue(true), acceptInvitation: vi.fn() };
  const access: SpaceAccess = {
    mode: 'showcase',
    canCreate: false,
    pendingTariff: null,
    teams: [],
    invitations: [],
    banner: null,
    toast: null,
    showcase: {
      plans: [],
      contact: { telegram: 'soty_admin', email: 'admin@example.test' },
      email: '',
      request: null
    }
  };
  render(
    <ToastProvider>
      <SpaceShowcase access={access} email={null} client={client} onAccepted={vi.fn()} />
    </ToastProvider>
  );
  const radios = screen.getAllByRole('radio') as HTMLInputElement[];
  expect(radios.map(r => r.checked)).toEqual([true, false]);
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  expect(client.joinWaitlist).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Написати адміністратору' }));
  const soloUrl = new URL(String(open.mock.calls[0][0]));
  expect(soloUrl.origin + soloUrl.pathname).toBe('https://t.me/Roma_mbuyer');
  expect(soloUrl.searchParams.get('text')).toContain('„Соло“ за $20/місяць');
  expect(client.joinWaitlist).toHaveBeenLastCalledWith('solo', 'telegram');
  fireEvent.click(radios[1]);
  expect(radios.map(r => r.checked)).toEqual([false, true]);
  fireEvent.click(screen.getByRole('button', { name: 'Написати адміністратору' }));
  const teamUrl = new URL(String(open.mock.calls[1][0]));
  expect(teamUrl.searchParams.get('text')).toContain('„Команда“ за від $30/місяць');
  expect(client.joinWaitlist).toHaveBeenLastCalledWith('lead', 'telegram');
  expect(open).toHaveBeenLastCalledWith(expect.any(String), '_blank', 'noopener,noreferrer');
  open.mockRestore();
});
