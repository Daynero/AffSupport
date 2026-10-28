// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchCard } from '../apps/web/src/team/launches/LaunchCard';
import type { LaunchSummary } from '@video-compressor/shared';
const locale = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../apps/web/src/i18n', async () => {
  const actual =
    await vi.importActual<typeof import('../apps/web/src/i18n')>('../apps/web/src/i18n');
  return { ...actual, useI18n: () => ({ ...actual.useI18n(), language: locale.language }) };
});
afterEach(() => {
  cleanup();
  locale.language = 'en';
  vi.restoreAllMocks();
});
function summary(patch: Partial<LaunchSummary> = {}): LaunchSummary {
  return {
    id: 'launch-one',
    version: '1',
    launchDate: null,
    offer: 'Offer',
    social: 'g1',
    creativeAlias: 'v5',
    method: 'other',
    workStatus: 'todo',
    assigneeId: null,
    budgets: [],
    generationState: null,
    ...patch
  };
}
it.each([
  ['en', 'M', 'Men'],
  ['uk', 'M', 'Чоловіки'],
  ['en', 'W', 'Women'],
  ['uk', 'W', 'Жінки'],
  ['en', 'ALL', 'All'],
  ['uk', 'ALL', 'Усі']
] as const)('renders %s %s audience and launch facts', (language, gender, expected) => {
  locale.language = language;
  render(
    <LaunchCard
      value={summary({
        gender,
        age: 45,
        campaignCount: 3,
        advantagePlus: true,
        createdAt: '2026-10-13T10:00:00Z',
        agentSuffix: '926',
        agentId: '1926',
        accountName: 'Social one',
        agentFree: false
      })}
      onOpen={vi.fn()}
    />
  );
  expect(screen.getByText(`${expected} 45+`)).toBeTruthy();
  expect(screen.getByText('Advantage+')).toBeTruthy();
  expect(screen.getByText('g1-926').title).toContain('1926');
  expect(document.querySelector('time')?.dateTime).toBe('2026-10-13');
});
it('keeps selection, copy and delete separate from opening the launch', () => {
  const open = vi.fn(),
    selected = vi.fn(),
    copy = vi.fn(),
    remove = vi.fn();
  const view = render(
    <LaunchCard
      value={summary({ generationState: 'partial', method: 'catalog' })}
      onOpen={open}
      onSelectedChange={selected}
      onCopyLink={copy}
      onDelete={remove}
    />
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select launch' }));
  expect(selected).toHaveBeenCalledWith(true, { shiftKey: false });
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Launch actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link to launch' }));
  expect(copy).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Launch actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete launch' }));
  expect(remove).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(view.container.querySelector('.launch-card-heading')!);
  expect(open).toHaveBeenCalledOnce();
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => 'selected text'
  } as Selection);
  fireEvent.click(view.container.querySelector('.launch-card-heading')!);
  expect(open).toHaveBeenCalledOnce();
});
it('shows in-flight attention and prevents disabled destructive actions', () => {
  const remove = vi.fn();
  render(
    <LaunchCard
      value={summary({ generationState: 'running' })}
      onOpen={vi.fn()}
      onDelete={remove}
      actionsDisabled
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Launch actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete launch' }));
  expect(remove).not.toHaveBeenCalled();
});
it('opens once from the body, edge, date and keyboard title, without a nested button surface', () => {
  const open = vi.fn();
  const view = render(
    <LaunchCard value={summary({ createdAt: '2026-10-13T10:00:00Z' })} onOpen={open} />
  );
  for (const selector of ['.launch-card-body', '.launch-card', 'time']) {
    fireEvent.click(view.container.querySelector(selector)!);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Offer' }));
  expect(open).toHaveBeenCalledTimes(4);
  expect(view.container.querySelector('.launch-card-body button')).toBeNull();
});
it('uses available identity for unnamed launches and omits an orphan separator', () => {
  const view = render(
    <LaunchCard
      value={summary({ offer: '', creativeAlias: '', social: 'Social', method: 'catalog' })}
      onOpen={vi.fn()}
    />
  );
  expect(screen.getByRole('button', { name: 'Social · Catalog' })).toBeTruthy();
  expect(view.container.querySelector('.launch-card-context')?.textContent).toBe('Catalog');
});

it('does not show a missing availability observation as a green Free source chip', () => {
  render(<LaunchCard value={summary({ agentId: '1234567892' })} onOpen={vi.fn()} />);
  const chip = screen.getByText('g1-892');
  expect(chip.classList.contains('is-free')).toBe(false);
  expect(chip.classList.contains('is-neutral')).toBe(true);
  expect(chip.dataset.availability).toBe('unknown');
  expect(chip.title).toContain('Availability unconfirmed');
});

it.each(['unassigned', 'released', 'reassigned'] as const)(
  'keeps %s launch source identity neutral without borrowing current RK availability',
  state => {
    render(
      <LaunchCard
        value={summary({
          agentId: '1234567892',
          agentFree: true,
          assignment: {
            launchId: 'launch-one',
            version: '2',
            state: state === 'reassigned' ? 'assigned' : state,
            agentRowId: state === 'reassigned' ? 'different-rk' : null,
            sourceAgentRowId: 'original-rk'
          }
        })}
        onOpen={vi.fn()}
      />
    );
    const chip = screen.getByText('g1-892');
    expect(chip.dataset.availability).toBe('historical');
    expect(chip.classList.contains('is-free')).toBe(false);
    expect(chip.classList.contains('is-neutral')).toBe(true);
    expect(chip.title).toContain('Original ad account · historical link');
    expect(chip.title).not.toContain('Free');
  }
);

it('shows legacy unconfirmed assignment as unknown rather than busy or free', () => {
  render(
    <LaunchCard
      value={summary({
        agentId: '1234567892',
        agentFree: false,
        assignment: {
          launchId: 'launch-one',
          version: '0',
          state: 'legacy_unknown',
          agentRowId: null,
          sourceAgentRowId: 'original-rk'
        }
      })}
      onOpen={vi.fn()}
    />
  );
  const chip = screen.getByText('g1-892');
  expect(chip.dataset.availability).toBe('unknown');
  expect(chip.title).toContain('Historical link · current assignment unconfirmed');
  expect(chip.title).not.toContain('Busy');
});

it('shows a confirmed assignment on its original source RK as busy', () => {
  render(
    <LaunchCard
      value={summary({
        agentId: '1234567892',
        agentFree: false,
        assignment: {
          launchId: 'launch-one',
          version: '1',
          state: 'assigned',
          agentRowId: 'original-rk',
          sourceAgentRowId: 'original-rk'
        }
      })}
      onOpen={vi.fn()}
    />
  );
  const chip = screen.getByText('g1-892');
  expect(chip.dataset.availability).toBe('busy');
  expect(chip.title).toContain('Current assignment confirmed for this ad account');
  expect(chip.title).toContain('Busy');
});

it('does not label contradictory assigned-and-free observations as known Free', () => {
  render(
    <LaunchCard
      value={summary({
        agentId: '1234567892',
        agentFree: true,
        assignment: {
          launchId: 'launch-one',
          version: '1',
          state: 'assigned',
          agentRowId: 'original-rk',
          sourceAgentRowId: 'original-rk'
        }
      })}
      onOpen={vi.fn()}
    />
  );
  const chip = screen.getByText('g1-892');
  expect(chip.dataset.availability).toBe('unknown');
  expect(chip.classList.contains('is-free')).toBe(false);
});

it('retains an explicit legacy boolean observation without manufacturing an assignment', () => {
  render(
    <LaunchCard value={summary({ agentId: '1234567892', agentFree: true })} onOpen={vi.fn()} />
  );
  const chip = screen.getByText('g1-892');
  expect(chip.dataset.availability).toBe('free');
  expect(chip.classList.contains('is-free')).toBe(true);
});
