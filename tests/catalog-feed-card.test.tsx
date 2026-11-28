// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck — the team snapshot keeps the minimal shape the other catalog tests use.
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';

/**
 * 057 T042 (FR-050): the catalog card of an R2 space shows its feed — the address Meta reads —
 * and copies it. Nothing on it speaks of Google or of a Google sheet. A Drive catalog is shown
 * exactly as before.
 */

const { AuthContextOverride } = await import('../apps/web/src/auth/AuthContext');
const { TeamProvider } = await import('../apps/web/src/team/TeamContext');
const { ToastProvider } = await import('../apps/web/src/components/toast');
const { setPrivateCacheScope } = await import('../apps/web/src/team/private-cache-scope');
const { CatalogDocumentLinks } =
  await import('../apps/web/src/team/product-catalog/CatalogFeedAddress');
const { CatalogPublicationBlockedNote } =
  await import('../apps/web/src/team/product-catalog/CatalogPublicationBlockedNote');

const R2 = '57420000-0000-4000-8000-000000000001';
const DRIVE = '57420000-0000-4000-8000-000000000002';
const CATALOG = '57420000-0000-4000-8000-000000000003';
const USER = 'feed-card-user';
const FEED_URL = `https://catalog-videos.soty.pp.ua/feeds/${'e'.repeat(32)}.csv`;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/sheet/edit';

const spaces = [
  {
    id: R2,
    name: 'Soty space',
    role: 'owner',
    permissions: DEFAULT_ROLE_PERMISSIONS.owner,
    connectionState: 'none',
    storageBackend: 'r2'
  },
  {
    id: DRIVE,
    name: 'Drive space',
    role: 'owner',
    permissions: DEFAULT_ROLE_PERMISSIONS.owner,
    connectionState: 'needs_reauth',
    storageBackend: 'drive'
  }
];

function wrap(children: React.ReactNode, active = R2) {
  localStorage.setItem('wishly.active-team.v1', active);
  return (
    <AuthContextOverride value={{ user: { id: USER } }}>
      <TeamProvider initialTeams={spaces} realtime={false}>
        <ToastProvider>{children}</ToastProvider>
      </TeamProvider>
    </AuthContextOverride>
  );
}

const blocked = {
  catalogId: CATALOG,
  revision: 3,
  mode: 'immediate',
  dueAt: null,
  timeZone: null,
  target: { kind: 'source', materialId: CATALOG, sourceVersion: '1' },
  job: {
    id: '57420000-0000-4000-8000-000000000009',
    state: 'blocked',
    revision: 3,
    writerFence: null,
    blockedReason: 'target_unavailable'
  },
  active: null,
  serverNow: Date.now()
};

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.setItem('language', 'uk');
  setPrivateCacheScope(USER, 'owner');
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the catalog card of an R2 space', () => {
  it('shows the feed address and copies it', async () => {
    render(wrap(<CatalogDocumentLinks teamId={R2} url={FEED_URL} name="Clip" />));
    const field = screen.getByRole('textbox', { name: 'Адреса стрічки для Meta' });
    expect(field).toHaveProperty('value', FEED_URL);
    expect(field).toHaveProperty('readOnly', true);
    await userEvent.click(screen.getByRole('button', { name: 'Скопіювати адресу стрічки Clip' }));
    expect(writeText).toHaveBeenCalledWith(FEED_URL);
    await waitFor(() => expect(screen.getByText('Адресу стрічки скопійовано')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Відкрити стрічку Clip' }).getAttribute('href')).toBe(
      FEED_URL
    );
    expect(document.body.textContent).not.toMatch(/Google|Таблиц/u);
  });

  it('a stopped publication speaks of the feed, never of Google, and offers no Drive reconnect', () => {
    render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={R2}
          catalogId={CATALOG}
          snapshot={blocked}
          onRetried={() => undefined}
        />
      )
    );
    expect(document.body.textContent).toContain('стрічку');
    expect(document.body.textContent).not.toMatch(/Google|Drive|таблиц/iu);
    expect(screen.getByRole('button', { name: 'Опублікувати ще раз' })).toBeTruthy();
  });
});

describe('a Drive catalog', () => {
  it('keeps its open and copy actions for the sheet', async () => {
    render(wrap(<CatalogDocumentLinks teamId={DRIVE} url={SHEET_URL} name="Clip" />, DRIVE));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('link', { name: 'Відкрити каталог' }).getAttribute('href')).toBe(
      SHEET_URL
    );
    await userEvent.click(screen.getByRole('button', { name: 'Скопіювати посилання на каталог' }));
    expect(writeText).toHaveBeenCalledWith(SHEET_URL);
  });

  it('a lost Drive still says so and offers the reconnect', () => {
    render(
      wrap(
        <CatalogPublicationBlockedNote
          teamId={DRIVE}
          catalogId={CATALOG}
          snapshot={blocked}
          onRetried={() => undefined}
        />,
        DRIVE
      )
    );
    expect(document.body.textContent).toContain('Google Drive');
  });
});
