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
  send: vi.fn(),
  review: vi.fn(),
  undo: vi.fn(),
  answer: vi.fn(),
  confirmProfile: vi.fn(),
  reviewLaunched: vi.fn(async () => undefined),
  launchMarks: vi.fn(async () => new Set())
}));
vi.mock('../apps/web/src/api/assistant', () => ({
  assistantApi: api,
  creditsApi: { status: vi.fn(async () => ({ ...credits, available })) }
}));
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

import { LaunchAssistant } from '../apps/web/src/team/launches/assistant/LaunchAssistant';
import { CreditsButton } from '../apps/web/src/credits/CreditsButton';
import { AiBudgetPanel } from '../apps/web/src/pages/admin/AiBudgetPanel';
import { refreshCredits } from '../apps/web/src/credits/store';

beforeEach(async () => {
  localStorage.clear();
  available = 87;
  Object.values(api).forEach(fn => fn.mockClear());
  api.open.mockImplementation(async () => ({
    enabled: true,
    canSaveDefaults: true,
    messages: [],
    credits: { ...credits, available }
  }));
  await refreshCredits();
});
afterEach(() => cleanup());

function assistant(onLaunch = vi.fn(async () => undefined)) {
  render(
    <LaunchAssistant
      teamId="team"
      canEdit
      onOpenLaunch={() => {}}
      onLaunch={onLaunch}
      onChanged={() => {}}
    />
  );
  return onLaunch;
}

describe('the assistant in Launches', () => {
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
    const [handed, key] = onLaunch.mock.calls[0]! as unknown as [
      Array<{ launchId: string; version: string }>,
      string
    ];
    expect(handed).toEqual(rows.map(row => ({ launchId: row.launchId, version: '1' })));
    expect(api.reviewLaunched).toHaveBeenCalledWith('card-review', key);
    expect(await screen.findByText('Sent to generation')).toBeTruthy();
  });

  it('offers review and undo on a result card, both free', async () => {
    const user = userEvent.setup();
    api.open.mockResolvedValueOnce({
      enabled: true,
      canSaveDefaults: true,
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
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith('team', 'cmd-1', expect.any(String)));
    expect(await screen.findByText('Undone: 2')).toBeTruthy();
  });

  it('stays hidden where the assistant is not enabled', async () => {
    api.open.mockResolvedValue({ enabled: false, canSaveDefaults: false, messages: [], credits });
    const { container } = render(
      <LaunchAssistant
        teamId="team"
        canEdit
        onOpenLaunch={() => {}}
        onLaunch={async () => {}}
        onChanged={() => {}}
      />
    );
    await waitFor(() => expect(api.open).toHaveBeenCalled());
    expect(container.querySelector('.launch-assistant')).toBeNull();
  });
});

describe('the credits button', () => {
  it('shows today’s balance and opens the details with the reset time and recent charges', async () => {
    const user = userEvent.setup();
    render(<CreditsButton />);
    await user.click(await screen.findByRole('button', { name: /Credits · 87/u }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Today 87 of 100')).toBeTruthy();
    expect(within(dialog).getByText(/Renew at .* Kyiv time/u)).toBeTruthy();
    expect(within(dialog).getByText(/Assistant · −1/u)).toBeTruthy();
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
      updatedAt: '2026-11-11T10:00:00Z'
    });
    render(<AiBudgetPanel />);
    expect(await screen.findByText('$60.00')).toBeTruthy();
    expect(screen.getByText('$120.00')).toBeTruthy();
    expect(screen.getByText(/Full use of grants exceeds the limit/u)).toBeTruthy();
    expect(screen.getByText(/Price coverage: 1.2/u)).toBeTruthy();
  });
});
