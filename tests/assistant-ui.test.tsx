// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@video-compressor/shared';

/**
 * 064: what a person sees of the assistant, the credits button and the AI budget. The model and
 * the server are mocked: these check the surfaces — prices on buttons, free card actions,
 * «Запустити N» handing exact rows to the batch, and the admin figures.
 */

const credits = {
  grant: 100,
  available: 87,
  day: '2026-11-21',
  resetsAt: '2026-11-21T22:00:00Z',
  paidOpen: true,
  recent: [
    {
      feature: 'launch_assistant' as const,
      kind: 'debit' as const,
      amount: 1,
      at: '2026-11-21T10:00:00Z'
    }
  ]
};
let available = 87;

const rows = [1, 2].map(n => ({
  n,
  launchId: `64400000-0000-4000-8000-00000000000${n}`,
  version: '1',
  account: 'G2',
  offer: 'ProCaps',
  creatives: ['TR_16.mp4'],
  launchDate: '2026-11-21',
  campaignCount: 2,
  productCount: 100,
  budget: '10–40',
  url: true,
  r2: false,
  blocked: []
}));

function message(
  cards: AssistantMessage['cards'],
  commandId: string | null = 'cmd-1'
): AssistantMessage {
  return {
    id: Math.random(),
    role: 'assistant',
    text: 'Готово.',
    price: 0,
    commandId,
    createdAt: '2026-11-21T10:00:00Z',
    cards
  };
}

const api = vi.hoisted(() => ({
  open: vi.fn(),
  newDialog: vi.fn(),
  send: vi.fn(),
  review: vi.fn(),
  undo: vi.fn(),
  answer: vi.fn(),
  confirmProfile: vi.fn(),
  reviewLaunched: vi.fn(async () => undefined),
  cardConfirmed: vi.fn(async () => undefined),
  launchMarks: vi.fn(async () => new Set())
}));
vi.mock('../apps/web/src/api/assistant', () => ({
  assistantApi: api,
  creditsApi: { status: vi.fn(async () => ({ ...credits, available })) }
}));
const bridge = vi.hoisted(() => ({
  launchRows: vi.fn(async () => undefined),
  openLaunch: vi.fn(),
  notifyLaunchesChanged: vi.fn()
}));
vi.mock('../apps/web/src/team/assistant/bridge', () => bridge);
const launches = vi.hoisted(() => ({ archive: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock('../apps/web/src/api/launches', () => ({ launchApi: launches }));
const releases = vi.hoisted(() => ({
  read: vi.fn(async () => ({ version: '5' })),
  release: vi.fn(async (..._args: unknown[]) => ({}))
}));
vi.mock('../apps/web/src/api/team-agent-release', () => ({ agentReleaseApi: releases }));
vi.mock('../apps/web/src/auth/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: 'u' } })
}));
const budget = vi.hoisted(() => ({
  overview: vi.fn(),
  spaces: vi.fn(async () => [{ teamId: 't1', name: 'Goor', pilot: true }]),
  setMonthLimit: vi.fn(),
  setBaseGrant: vi.fn(),
  setUserGrant: vi.fn(),
  setAssistantEnabled: vi.fn(),
  setSpace: vi.fn()
}));
vi.mock('../apps/web/src/api/ai-budget', () => ({ aiBudgetApi: budget }));

import { AssistantWidget } from '../apps/web/src/team/assistant/AssistantWidget';
import { CreditsButton } from '../apps/web/src/credits/CreditsButton';
import { AiBudgetPanel } from '../apps/web/src/pages/admin/AiBudgetPanel';
import { refreshCredits } from '../apps/web/src/credits/store';

const dialog = {
  conversationId: 'd1',
  title: null,
  dialogs: [{ id: 'd1', title: null, lastActiveAt: '2026-11-21T10:00:00Z' }]
};

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('soty.assistant.open', '1');
  available = 87;
  Object.values(api).forEach(fn => fn.mockClear());
  Object.values(bridge).forEach(fn => fn.mockClear());
  launches.archive.mockClear();
  api.open.mockImplementation(async () => ({
    enabled: true,
    canSaveDefaults: true,
    ...dialog,
    messages: [],
    credits: { ...credits, available }
  }));
  await refreshCredits();
});
afterEach(() => cleanup());

function assistant() {
  render(<AssistantWidget teamId="team" canEdit />);
  return bridge.launchRows;
}

describe('the space assistant', () => {
  it('folds into a corner button and opens again from it', async () => {
    const user = userEvent.setup();
    assistant();
    await screen.findByRole('textbox');
    expect(screen.getByText('Dialogs are kept for 7 days')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Assistant' }));
    expect(await screen.findByRole('textbox')).toBeTruthy();
  });

  it('starts a new dialog and sends in the open one', async () => {
    const user = userEvent.setup();
    api.newDialog.mockResolvedValue({
      enabled: true,
      canSaveDefaults: true,
      conversationId: 'd2',
      title: null,
      dialogs: [...dialog.dialogs, { id: 'd2', title: null, lastActiveAt: '2026-11-21T11:00:00Z' }],
      messages: [],
      credits
    });
    api.send.mockResolvedValue({ commandId: 'c', replayed: false, message: message([]), credits });
    assistant();
    await screen.findByRole('textbox');
    await user.click(screen.getByRole('button', { name: 'New dialog' }));
    await waitFor(() => expect(api.newDialog).toHaveBeenCalledWith('team'));
    await user.type(screen.getByRole('textbox'), '5 запусків ProCaps на G2{Enter}');
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0]![0]).toMatchObject({ dialogId: 'd2' });
  });

  it('shows the price on the send button and sends with Ctrl+Enter', async () => {
    const user = userEvent.setup();
    api.send.mockResolvedValue({
      commandId: 'c',
      replayed: false,
      message: message([]),
      credits: { ...credits, available: 86 }
    });
    assistant();
    const field = await screen.findByRole('textbox');
    await user.type(field, '5 запусків ProCaps на G2');
    expect(screen.getByRole('button', { name: /Send · 1 credit/u })).toBeTruthy();
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0]![0]).toMatchObject({
      text: '5 запусків ProCaps на G2',
      price: 1
    });
  });

  it('sends a short reply for free', async () => {
    const user = userEvent.setup();
    assistant();
    await user.type(await screen.findByRole('textbox'), 'запускай');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('disables sending and says how much is missing when credits do not cover the price', async () => {
    available = 0;
    await refreshCredits();
    const user = userEvent.setup();
    assistant();
    await user.type(await screen.findByRole('textbox'), '5 запусків ProCaps на G2');
    expect(screen.getByText(/Short by 1 · renews at/u)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Send · 1 credit/u }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('launches exactly the reviewed rows through the batch, with their versions, once', async () => {
    const user = userEvent.setup();
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 'card-review',
            kind: 'review',
            state: 'open',
            commandId: 'cmd-1',
            payload: { date: '2026-11-21', rows, ready: 2 },
            createdAt: 'x'
          }
        ])
      ]
    });
    const onLaunch = assistant();
    await user.click(await screen.findByRole('button', { name: 'Launch 2' }));
    await waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    const [space, handed, key] = onLaunch.mock.calls[0]! as unknown as [
      string,
      Array<{ launchId: string; version: string }>,
      string
    ];
    expect(space).toBe('team');
    expect(handed).toEqual(rows.map(row => ({ launchId: row.launchId, version: '1' })));
    expect(api.reviewLaunched).toHaveBeenCalledWith('card-review', key);
    expect(await screen.findByText('Sent to generation')).toBeTruthy();
  });

  it('offers review and undo on a result card, both free', async () => {
    const user = userEvent.setup();
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 'card-result',
            kind: 'result',
            state: 'open',
            commandId: 'cmd-1',
            payload: { rows, campaigns: 4, date: '2026-11-21', differences: [], unresolved: [] },
            createdAt: 'x'
          }
        ])
      ]
    });
    api.undo.mockResolvedValue({
      commandId: 'u',
      replayed: false,
      message: message([
        {
          id: 's',
          kind: 'status',
          state: 'open',
          commandId: null,
          payload: { undone: 2, kept: [] },
          createdAt: 'x'
        }
      ]),
      credits
    });
    assistant();
    expect(await screen.findByText(/2 drafts/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(api.undo).toHaveBeenCalledWith('team', 'd1', 'cmd-1', expect.any(String))
    );
    expect(await screen.findByText('Undone: 2')).toBeTruthy();
  });

  it('removes the drafts of an archive card only when the button is pressed', async () => {
    const user = userEvent.setup();
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 'card-archive',
            kind: 'review',
            state: 'open',
            commandId: 'cmd-1',
            payload: { purpose: 'archive', rows, ready: 2, launchedKept: 1 },
            createdAt: 'x'
          }
        ])
      ]
    });
    assistant();
    expect(await screen.findByText(/Remove drafts: 2/u)).toBeTruthy();
    expect(screen.getByText(/Launched ones stay: 1/u)).toBeTruthy();
    expect(launches.archive).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove 2' }));
    await waitFor(() => expect(launches.archive).toHaveBeenCalledTimes(2));
    expect(launches.archive.mock.calls.map(call => [call[1], call[2]])).toEqual(
      rows.map(row => [row.launchId, '1'])
    );
    expect(api.cardConfirmed).toHaveBeenCalledWith('card-archive');
    expect(await screen.findByText('Removed: 2')).toBeTruthy();
  });

  it('says when it created an offer', async () => {
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 's',
            kind: 'status',
            state: 'open',
            commandId: null,
            payload: { offersCreated: ['Flexi TR'] },
            createdAt: 'x'
          }
        ])
      ]
    });
    assistant();
    expect(await screen.findByText('Offer «Flexi TR» created')).toBeTruthy();
  });

  it('names default fields in words and closes the card once saved', async () => {
    const user = userEvent.setup();
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 'card-profile',
            kind: 'profile',
            state: 'open',
            commandId: 'cmd-1',
            payload: {
              offer: 'Soty QA TR',
              changes: [
                { field: 'campaignCount', from: null, to: '3' },
                { field: 'budgetMode', from: null, to: '"auto"' }
              ]
            },
            createdAt: 'x'
          }
        ])
      ]
    });
    api.confirmProfile.mockResolvedValue({
      commandId: 'c',
      replayed: false,
      message: null,
      credits
    });
    assistant();
    expect(await screen.findByText('Campaigns: — → 3')).toBeTruthy();
    expect(screen.getByText('Budget: — → range')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  });

  it('marks a result card undone and stops offering its actions', async () => {
    const user = userEvent.setup();
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 'card-result',
            kind: 'result',
            state: 'open',
            commandId: 'cmd-1',
            payload: { rows, campaigns: 4, date: '2026-11-21', differences: [], unresolved: [] },
            createdAt: 'x'
          }
        ])
      ]
    });
    api.undo.mockResolvedValue({ commandId: 'u', replayed: false, message: null, credits });
    assistant();
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(/Undone — these changes are gone/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Launch 2' })).toBeNull();
  });

  it('opens a launch from its row and folds the window, without a row-wide button', async () => {
    const user = userEvent.setup();
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 'card-result',
            kind: 'result',
            state: 'open',
            commandId: 'cmd-1',
            payload: { rows, campaigns: 4, date: '2026-11-21', differences: [], unresolved: [] },
            createdAt: 'x'
          }
        ])
      ]
    });
    assistant();
    const open = await screen.findAllByRole('button', { name: 'Open launch' });
    expect(open).toHaveLength(2);
    await user.click(open[1]!);
    expect(bridge.openLaunch).toHaveBeenCalledWith('team', rows[1]!.launchId);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Assistant' })).toBeTruthy();
  });

  it('says a draft is not ready and what to write instead of a success tick', async () => {
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 'card-result',
            kind: 'result',
            state: 'open',
            commandId: 'cmd-1',
            payload: {
              rows: [
                { ...rows[0]!, account: null, blocked: [{ field: 'agentRowId', code: 'MISSING' }] }
              ],
              campaigns: 2,
              date: '2026-11-21',
              differences: [],
              unresolved: []
            },
            createdAt: 'x'
          }
        ])
      ]
    });
    assistant();
    expect(await screen.findByText(/Not ready to launch: 1/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Launch/u })).toBeNull();
  });

  it('frees the listed ad accounts as Accounts does, skipping old assignments', async () => {
    const user = userEvent.setup();
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
      ...dialog,
      credits,
      messages: [
        message([
          {
            id: 'card-release',
            kind: 'review',
            state: 'open',
            commandId: 'cmd-1',
            payload: {
              purpose: 'release',
              rows: [],
              agents: [
                { agentRowId: 'a1', label: 'g18-046', launches: 2, runs: 1, legacy: 0 },
                { agentRowId: 'a2', label: 'g4-257', launches: 1, runs: 0, legacy: 1 }
              ]
            },
            createdAt: 'x'
          }
        ])
      ]
    });
    assistant();
    expect(await screen.findByText('Free ad accounts: 2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Free 1' }));
    await waitFor(() => expect(releases.release).toHaveBeenCalledTimes(1));
    expect(releases.release.mock.calls[0]![0]).toMatchObject({
      teamId: 'team',
      agentRowId: 'a1',
      expectedVersion: '5'
    });
    expect(await screen.findByText('Freed: 1')).toBeTruthy();
  });

  it('stays hidden where the assistant is not enabled', async () => {
    api.open.mockResolvedValue({ enabled: false, canSaveDefaults: false, messages: [], credits });
    const { container } = render(<AssistantWidget teamId="team" canEdit />);
    await waitFor(() => expect(api.open).toHaveBeenCalled());
    expect(container.querySelector('.assistant-dock')).toBeNull();
  });
});

describe('the credits button', () => {
  it('shows the whole balance and splits it into daily and bonus, without a price list', async () => {
    const user = userEvent.setup();
    available = 97;
    api.open.mockClear();
    const status = { ...credits, available: 97, daily: 87, bonus: 10 };
    const { creditsApi } = await import('../apps/web/src/api/assistant');
    vi.mocked(creditsApi.status).mockResolvedValueOnce(status);
    await refreshCredits();
    render(<CreditsButton />);
    await user.click(await screen.findByRole('button', { name: '97 credits' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('87 of 100')).toBeTruthy();
    expect(within(dialog).getByText('10')).toBeTruthy();
    expect(within(dialog).getByText(/Renew at .* Kyiv time/u)).toBeTruthy();
    expect(within(dialog).queryByText(/Assistant · −1/u)).toBeNull();
  });
});

describe('the AI budget panel', () => {
  it('shows limit, spend, what is free, the forecast and full grant use', async () => {
    budget.overview.mockResolvedValue({
      month: '2026-11',
      day: '2026-11-11',
      daysInMonth: 30,
      fullDays: 10,
      limitUsd: 100,
      spentUsd: 40,
      heldUsd: 0,
      freeUsd: 60,
      forecastUsd: 120,
      fullGrantUseUsd: 130,
      byFeature: [
        {
          feature: 'launch_assistant',
          spentUsd: 10,
          chargedCredits: 12000,
          coverage: 1.2,
          unknownCalls: 0
        }
      ],
      creditUsd: 0.001,
      baseDailyGrant: 100,
      assistantEnabled: true,
      grants: [],
      bonuses: [{ email: 'a@example.com', balance: 40 }],
      updatedAt: '2026-11-11T10:00:00Z'
    });
    render(<AiBudgetPanel />);
    expect(await screen.findByText('$60.00')).toBeTruthy();
    expect(screen.getByText('$120.00')).toBeTruthy();
    expect(screen.getByText(/Full use of grants exceeds the limit/u)).toBeTruthy();
    expect(screen.getByText(/prices cover cost ×1.20/u)).toBeTruthy();
    // plain words: the rate, the worst case explained, the daily grant in money
    expect(screen.getByText('1 credit ≈ $0.001')).toBeTruthy();
    expect(screen.getByText('Worst case this month')).toBeTruthy();
    expect(screen.getByText(/100 credits ≈ \$0.100 per person a day/u)).toBeTruthy();
    // people and the pilot moved to Tariffs
    expect(screen.queryByText('a@example.com')).toBeNull();
  });
});
