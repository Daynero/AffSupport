// @vitest-environment jsdom
import React, { type ReactNode } from 'react';
import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TOOL_CONTRACTS } from '../packages/shared/src/release.js';
import { ToastProvider } from '../apps/web/src/components/toast.js';

/*
 * 073: downloading a selection. With Soty ready every file is a job in the space's queue, saved
 * into Downloads/Soty/<folder>; without it the browser takes the files one after another, and
 * the ones only Soty may fetch are counted with the way to get it. Folders are skipped, aloud.
 */

const state = vi.hoisted(() => ({
  agent: null as null | {
    teamWorkspaceAvailability: string;
    toolContracts: object;
    connection: string;
  },
  queue: null as null | { enqueue: ReturnType<typeof vi.fn> }
}));

vi.mock('../apps/web/src/AgentContext', async original => ({
  ...(await original<typeof import('../apps/web/src/AgentContext')>()),
  useOptionalAgent: () => state.agent
}));
vi.mock('../apps/web/src/team/processing/AgentQueueProvider', async original => ({
  ...(await original<typeof import('../apps/web/src/team/processing/AgentQueueProvider')>()),
  useOptionalSpaceAgentQueue: () => (state.queue ? { queue: state.queue, stack: null } : null)
}));
const requestDownload = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/api/team', async original => {
  const real = await original<typeof import('../apps/web/src/api/team')>();
  return { ...real, teamApi: { ...real.teamApi, requestDownload } };
});

const { useSelectionDownload } = await import('../apps/web/src/team/explorer/useSelectionDownload');

const TEAM = '22222222-2222-4222-8222-222222222222';
const file = (id: string, name: string) => ({ id, teamId: TEAM, name, kind: 'file' });
const folder = { id: 'folder-1', teamId: TEAM, name: 'GN', kind: 'folder' };

/** A JPEG whose EXIF names the phone. */
const photo = new Uint8Array([
  ...[0xff, 0xd8, 0xff, 0xe1, 0x00, 0x16],
  ...new TextEncoder().encode('Exif\0\0iPhone 15 Pro!'),
  ...[0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0xff, 0xd9]
]);

const wrapper = ({ children }: { children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

let saved: Blob[];
let order: string[];

beforeEach(() => {
  localStorage.setItem('language', 'en');
  state.agent = null;
  state.queue = null;
  saved = [];
  order = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      saved.push(blob);
      order.push('saved');
      return `blob:${saved.length}`;
    }),
    revokeObjectURL: vi.fn()
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(photo)));
  requestDownload.mockReset().mockImplementation(async (_team: string, id: string) => {
    order.push(`grant:${id}`);
    if (id === 'big') throw Object.assign(new Error('AGENT_REQUIRED'), { code: 'AGENT_REQUIRED' });
    return {
      kind: 'browser',
      rangeUrl: `https://project.supabase.co/download/${id}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      disposition: 'attachment'
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('downloading a selection (073)', () => {
  it('without Soty saves the files one after another, clean, and skips a folder aloud', async () => {
    const { result } = renderHook(() => useSelectionDownload({ folderName: 'GN' }), { wrapper });
    await act(() =>
      result.current.download([file('a', 'a.jpg'), folder, file('b', 'b.jpg')], 'clean')
    );
    // Never two at once: each file's grant comes after the previous file was saved.
    expect(order).toEqual(['grant:a', 'saved', 'grant:b', 'saved']);
    for (const blob of saved) {
      const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
      expect(text).not.toContain('iPhone');
    }
    expect(await screen.findByText(/Folders are not downloaded: 1 skipped/u)).toBeTruthy();
    expect(await screen.findByText(/Files downloaded: 2/u)).toBeTruthy();
  });

  it('keeps the metadata when asked, and counts what only Soty may fetch with the way to it', async () => {
    const onNeedsApp = vi.fn();
    const { result } = renderHook(() => useSelectionDownload({ folderName: null, onNeedsApp }), {
      wrapper
    });
    await act(() =>
      result.current.download([file('a', 'a.jpg'), file('big', 'big.mp4')], 'original')
    );
    expect(saved).toHaveLength(1);
    expect(new Uint8Array(await saved[0]!.arrayBuffer())).toEqual(photo);
    expect(await screen.findByText(/Files larger than 32 MB: 1/u)).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'Open Soty' }).click());
    expect(onNeedsApp).toHaveBeenCalledOnce();
  });

  it('with Soty ready queues every file for Downloads/Soty/<folder>, nothing in the browser', async () => {
    state.agent = {
      teamWorkspaceAvailability: 'ready',
      toolContracts: AGENT_TOOL_CONTRACTS,
      connection: 'connected'
    };
    state.queue = { enqueue: vi.fn() };
    const { result } = renderHook(() => useSelectionDownload({ folderName: 'GN' }), { wrapper });
    await act(() => result.current.download([file('a', 'a.jpg'), file('big', 'big.mp4')], 'clean'));
    expect(state.queue.enqueue).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'a',
        tool: 'download',
        deliver: { saveInto: 'GN', metadata: 'clean' }
      }),
      expect.objectContaining({
        id: 'big',
        tool: 'download',
        deliver: { saveInto: 'GN', metadata: 'clean' }
      })
    ]);
    expect(requestDownload).not.toHaveBeenCalled();
  });

  it('does not hand a clean batch to a Soty that cannot clean; the browser takes it instead', async () => {
    state.agent = {
      teamWorkspaceAvailability: 'ready',
      toolContracts: { ...AGENT_TOOL_CONTRACTS, teamCleanDelivery: 0 },
      connection: 'connected'
    };
    state.queue = { enqueue: vi.fn() };
    const { result } = renderHook(() => useSelectionDownload({ folderName: 'GN' }), { wrapper });
    await act(() => result.current.download([file('a', 'a.jpg')], 'clean'));
    expect(state.queue.enqueue).not.toHaveBeenCalled();
    await waitFor(() => expect(saved).toHaveLength(1));
  });
});
