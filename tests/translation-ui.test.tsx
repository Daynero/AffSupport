// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  translationFingerprint,
  type TranscriptTranslation,
  type TranslationStreamEvent
} from '@video-compressor/shared';
import { VideoTextActions } from '../apps/web/src/team/library/VideoTextActions';
import { allowanceFigures } from '../apps/web/src/translation/format';
import type { TranslationClient } from '../apps/web/src/translation/api';
import { TeamApiError } from '../apps/web/src/api/team';
import { refreshCredits } from '../apps/web/src/credits/store';

// 064: translation pays in credits; the balance comes from one server read the test controls.
let creditsStatus = {
  grant: 100,
  available: 87,
  day: '2026-11-21',
  resetsAt: '2026-11-21T22:00:00Z',
  paidOpen: true,
  recent: [] as never[]
};
vi.mock('../apps/web/src/api/assistant', () => ({
  creditsApi: { status: vi.fn(async () => creditsStatus) },
  assistantApi: {}
}));

/**
 * 063: what a person sees around a space transcript. The cost and remainder agree with the
 * decision; a text that does not fit offers no button that would do nothing; every translation
 * sits beside the original and Copy copies the one that is open.
 */

const TEAM = '06300000-0000-4000-8000-0000000000aa';
const VIDEO = '06300000-0000-4000-8000-0000000000bb';

function translation(overrides: Partial<TranscriptTranslation> = {}): TranscriptTranslation {
  return {
    id: '06300000-0000-4000-8000-000000000001',
    scope: 'team_video',
    targetLanguage: 'uk',
    sourceLanguage: 'tr',
    sourceFingerprint: `v1:${'0'.repeat(64)}`,
    status: 'completed',
    failureCode: null,
    segments: ['Привіт.', 'Візьми таблетку.'],
    totalSegments: 2,
    completedSegments: 2,
    units: 23,
    model: 'claude-haiku-5-5',
    createdAt: '2026-11-21T10:00:00Z',
    completedAt: '2026-11-21T10:00:20Z',
    ...overrides
  };
}

function fakeClient(overrides: Partial<TranslationClient> = {}): TranslationClient {
  return {
    start: vi.fn(),
    watch: vi.fn(async () => undefined),
    listForVideo: vi.fn(async () => []),
    listPersonal: vi.fn(async () => []),
    get: vi.fn(async () => translation()),
    remove: vi.fn(async () => undefined),
    allowance: vi.fn(async () => ({
      feature: 'transcript_translation',
      limitUnits: 9000,
      usedUnits: 2700,
      day: '2026-11-21',
      resetsAt: '2026-11-21T22:00:00Z'
    })),
    ...overrides
  };
}

const textClient = {
  listVideoTextVariants: async () => ({
    sourceVersion: 'v1',
    canProcess: true,
    variants: [
      {
        materialId: 'm-1',
        kind: 'original' as const,
        language: 'tr',
        ingestState: 'full' as const,
        truncated: false,
        text: 'Merhaba.\nBir tablet al.',
        updatedAt: '2026-11-21T09:00:00Z'
      }
    ]
  })
};

beforeEach(async () => {
  localStorage.clear();
  creditsStatus = { ...creditsStatus, available: 87, paidOpen: true };
  await refreshCredits();
});
afterEach(() => cleanup());

describe('allowance figures', () => {
  it('shows minutes of text that agree with the decision', () => {
    expect(allowanceFigures(2_700, 2_700, 9_000)).toMatchObject({
      need: 3,
      left: 7,
      limit: 10,
      fits: true
    });
    // A tiny text that fits a remainder rounding to zero is never shown as costing more.
    expect(allowanceFigures(10, 8_980, 9_000)).toMatchObject({ fits: true, need: 0, left: 0 });
    // Does not fit but rounds equal: the cost is shown a tenth above.
    expect(allowanceFigures(1_810, 7_200, 9_000)).toMatchObject({
      fits: false,
      need: 2.1,
      left: 2
    });
    expect(allowanceFigures(12_600, 0, 9_000)).toMatchObject({ fits: false, overDaily: true });
  });
});

describe('translating a space transcript', () => {
  it('shows the price on the button before anything starts, and starts the chosen language', async () => {
    const user = userEvent.setup();
    const start = vi.fn(async () => ({
      translationId: '06300000-0000-4000-8000-000000000009',
      status: 'processing' as const,
      reused: false,
      units: 23,
      allowance: null
    }));
    const client = fakeClient({ start });
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={client}
        onTranscribe={() => {}}
      />
    );
    // 23 characters are one started minute: one credit, on the button itself.
    await user.click(await screen.findByRole('button', { name: /Translate · 1/u }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('87 credits')).toBeTruthy());
    await user.click(within(dialog).getByRole('button', { name: 'Translate · 1' }));
    expect(start).toHaveBeenCalledWith(
      'uk',
      { scope: 'team_video', teamId: TEAM, videoId: VIDEO },
      1
    );
    expect(await screen.findByText(/Translating: Ukrainian/u)).toBeTruthy();
  });

  it('says how many credits are missing and offers no button when they do not cover it', async () => {
    const user = userEvent.setup();
    creditsStatus = { ...creditsStatus, available: 0 };
    await refreshCredits();
    const client = fakeClient();
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={client}
        onTranscribe={() => {}}
      />
    );
    await user.click(await screen.findByRole('button', { name: /Translate · 1/u }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Short by 1 · renews at/u)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Translate · 1/u })).toBeNull();
  });

  it('re-reads the balance when the server refuses for credits', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      start: vi.fn(async () => {
        // Another tab spent the last credits in between.
        creditsStatus = { ...creditsStatus, available: 0 };
        throw new TeamApiError('INSUFFICIENT_CREDITS', false, { needed: 1, available: 0 });
      })
    });
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={client}
        onTranscribe={() => {}}
      />
    );
    await user.click(await screen.findByRole('button', { name: /Translate · 1/u }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Translate · 1' }));
    expect(await within(dialog).findByText(/Short by 1 · renews at/u)).toBeTruthy();
  });
});

describe('several texts', () => {
  it('lists every translation beside the original and copies the one that is open', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const current = await translationFingerprint(['Merhaba.', 'Bir tablet al.']);
    const client = fakeClient({
      listForVideo: vi.fn(async () => [
        translation({ sourceFingerprint: current }),
        translation({
          sourceFingerprint: current,
          id: '06300000-0000-4000-8000-000000000002',
          targetLanguage: 'es-MX',
          segments: ['Hola.', 'Toma una tableta.']
        })
      ])
    });
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={client}
        onTranscribe={() => {}}
      />
    );
    await user.click(await screen.findByRole('button', { name: 'Copy text' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Original · TR')).toBeTruthy();
    expect(within(menu).getByText('Ukrainian')).toBeTruthy();
    await user.click(within(menu).getByRole('menuitem', { name: /Spanish/u }));
    expect(write).toHaveBeenCalledWith('Hola.\nToma una tableta.');

    await user.click(screen.getByRole('button', { name: 'View text' }));
    const viewer = screen.getByRole('dialog');
    const tabs = within(viewer).getByRole('tablist');
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual(['Original · TR', 'Ukrainian', expect.stringMatching(/Spanish/u)]);
    await user.click(within(tabs).getByRole('tab', { name: 'Ukrainian' }));
    expect(viewer.textContent).toContain('Візьми таблетку.');
    await user.click(within(viewer).getByRole('button', { name: 'Copy text' }));
    expect(write).toHaveBeenLastCalledWith('Привіт.\nВізьми таблетку.');
  });

  it('marks a translation made from an earlier text and offers to update it', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ listForVideo: vi.fn(async () => [translation()]) });
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={client}
        onTranscribe={() => {}}
      />
    );
    await user.click(await screen.findByRole('button', { name: 'View text' }));
    await user.click(within(screen.getByRole('tablist')).getByRole('tab', { name: /Ukrainian/u }));
    expect(await screen.findByText('Translated from an earlier version of the text')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Update translation/u })).toBeTruthy();
  });

  it('says a refusal calmly, returns the minutes and offers to try again', async () => {
    const user = userEvent.setup();
    const start = vi.fn(async () => ({
      translationId: '06300000-0000-4000-8000-000000000001',
      status: 'processing' as const,
      reused: false,
      units: 23,
      allowance: null
    }));
    const client = fakeClient({
      start,
      listForVideo: vi.fn(async () => [
        translation({
          status: 'failed',
          failureCode: 'TRANSLATION_REFUSED',
          segments: null,
          completedSegments: 0,
          model: null,
          completedAt: null
        })
      ])
    });
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={client}
        onTranscribe={() => {}}
      />
    );
    expect(
      await screen.findByText(/declined to translate this text\. Minutes returned\./u)
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(start).toHaveBeenCalledWith(
      'uk',
      { scope: 'team_video', teamId: TEAM, videoId: VIDEO },
      1
    );
  });

  it('keeps the text readable where the space cannot transcribe', async () => {
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={fakeClient()}
      />
    );
    expect(await screen.findByRole('button', { name: 'View text' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Redo/u })).toBeNull();
  });

  it('says "outdated" in words and deletes a translation after confirming', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ listForVideo: vi.fn(async () => [translation()]) });
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={client}
        onTranscribe={() => {}}
      />
    );
    expect(await screen.findByText('outdated')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'View text' }));
    await user.click(within(screen.getByRole('tablist')).getByRole('tab', { name: /Ukrainian/u }));
    await user.click(screen.getByRole('button', { name: 'Delete translation' }));
    const confirm = await screen.findByRole('dialog', {
      name: /Delete the Ukrainian translation/u
    });
    await user.click(within(confirm).getByRole('button', { name: 'Delete translation' }));
    await waitFor(() =>
      expect(client.remove).toHaveBeenCalledWith('06300000-0000-4000-8000-000000000001')
    );
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Ukrainian/u })).toBeNull());
  });

  it('follows a running translation to its result', async () => {
    let emit: ((event: TranslationStreamEvent) => void) | null = null;
    let finish: () => void = () => {};
    const client = fakeClient({
      listForVideo: vi.fn(async () => [
        translation({
          status: 'processing',
          segments: null,
          completedSegments: 0,
          model: null,
          completedAt: null
        })
      ]),
      watch: vi.fn(
        (_id, onEvent) =>
          new Promise<void>(resolve => {
            emit = onEvent;
            finish = resolve;
          })
      )
    });
    render(
      <VideoTextActions
        teamId={TEAM}
        videoId={VIDEO}
        client={textClient}
        translations={client}
        onTranscribe={() => {}}
      />
    );
    expect(await screen.findByText(/Translating: Ukrainian/u)).toBeTruthy();
    emit!({ type: 'progress', status: 'processing', completedSegments: 1, totalSegments: 2 });
    emit!({ type: 'done', translation: translation() });
    finish();
    await waitFor(() => expect(screen.queryByText(/Translating: Ukrainian/u)).toBeNull());
    expect(screen.getByRole('button', { name: 'Ukrainian' })).toBeTruthy();
  });
});
