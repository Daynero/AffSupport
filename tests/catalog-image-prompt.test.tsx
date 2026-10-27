// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CATALOG_IMAGE_GARMENTS,
  CATALOG_IMAGE_COLORS,
  DEFAULT_ROLE_PERMISSIONS
} from '@video-compressor/shared';
import {
  CATALOG_IMAGE_PROMPT,
  CATALOG_IMAGE_PROMPT_VERSION,
  recordCatalogImagePrompt
} from '../apps/web/src/team/product-catalog/catalogImagePrompt';
import { catalogImageClient } from '../apps/web/src/api/team-catalog-images';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { CatalogImageImport } from '../apps/web/src/team/product-catalog/CatalogImageImport';

const events = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../apps/web/src/analytics/service', () => ({ analytics: events }));

beforeEach(() => {
  events.track.mockReset();
  localStorage.setItem('language', 'en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it('keeps every prompt filename token compatible with the canonical vocabulary', () => {
  const garmentLine = CATALOG_IMAGE_PROMPT.match(/^ТИПИ: (.+)$/mu)?.[1];
  const colorLine = CATALOG_IMAGE_PROMPT.match(/^КОЛЬОРИ: (.+)$/mu)?.[1];
  expect(garmentLine?.split(', ')).toEqual(CATALOG_IMAGE_GARMENTS.map(([token]) => token));
  expect(colorLine?.split(', ')).toEqual([...CATALOG_IMAGE_COLORS]);
  expect(CATALOG_IMAGE_PROMPT).toContain('1:1');
  expect(CATALOG_IMAGE_PROMPT).toContain('1024×1024');
  expect(CATALOG_IMAGE_PROMPT).toContain('брендів');
  expect(CATALOG_IMAGE_PROMPT_VERSION).toBe('catalog-clothing-v1');
});

it('records only fixed prompt metadata and cannot export clipboard text', () => {
  recordCatalogImagePrompt('succeeded', 'flow-safe');
  expect(events.track).toHaveBeenCalledWith(
    'operation_completed',
    expect.objectContaining({
      flow_id: 'flow-safe',
      action_identifier: 'succeeded',
      setting_value: CATALOG_IMAGE_PROMPT_VERSION
    })
  );
  expect(JSON.stringify(events.track.mock.calls)).not.toContain(CATALOG_IMAGE_PROMPT);
});

function mount() {
  vi.spyOn(catalogImageClient, 'capabilities').mockResolvedValue({
    enabled: false,
    importEnabled: false,
    canManage: false,
    contractVersion: 2,
    mode: 'legacy'
  });
  const id = '22000000-0000-4000-8000-0000000000aa';
  return render(
    <TeamProvider
      realtime={false}
      initialTeams={[
        {
          id,
          name: 'Space',
          role: 'owner',
          permissions: DEFAULT_ROLE_PERMISSIONS.owner,
          connectionState: 'connected'
        }
      ]}
    >
      <CatalogImageImport teamId={id} client={catalogImageClient} onPool={vi.fn()} />
    </TeamProvider>
  );
}

it('passes the full prompt to the clipboard rather than a link or shortened excerpt', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(CATALOG_IMAGE_PROMPT));
  expect(await screen.findByText('Prompt copied')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Copy prompt' })).toBeNull();
});

it('never reports success when clipboard is denied and offers the complete manual text', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async () => {
        throw new Error('denied');
      })
    }
  });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open prompt' }));
  expect(screen.queryByText('Prompt copied')).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Copy prompt' }) as HTMLTextAreaElement).value).toBe(
    CATALOG_IMAGE_PROMPT
  );
});
