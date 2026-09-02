// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openFolderPicker, PickerUnavailableError } from '../apps/web/src/team/storage/loadPicker';

/**
 * How the folder chooser is configured, which until now nothing checked.
 *
 * Every test around the connect flow replaces `pickFolders` wholesale, so the one piece that
 * decides what a person actually sees — the views handed to Google's chooser — was covered by
 * nothing at all. That is where the "every folder I own, in one flat heap" report came from.
 *
 * The chooser itself is Google's and cannot be rendered here; what is asserted is the
 * configuration it is given, which is the whole of what this codebase controls.
 */

interface RecordedView {
  viewId?: unknown;
  selectFolderEnabled?: boolean;
  includeFolders?: boolean;
  mimeTypes?: string;
  enableDrives?: boolean;
  mode?: unknown;
}

const CONFIG = { apiKey: 'key', appId: 'app' };

function fakePicker() {
  const views: RecordedView[] = [];
  const features: unknown[] = [];
  let visible = false;
  let callback: ((data: unknown) => void) | null = null;

  const namespace = {
    ViewId: { FOLDERS: 'folders', DOCS: 'docs' },
    DocsViewMode: { LIST: 'list', GRID: 'grid' },
    Feature: { SUPPORT_DRIVES: 'drives', MULTISELECT_ENABLED: 'multi' },
    Action: { PICKED: 'picked', CANCEL: 'cancel' },
    DocsView: class {
      readonly record: RecordedView = {};
      constructor(viewId: unknown) {
        this.record.viewId = viewId;
        views.push(this.record);
      }
      setSelectFolderEnabled(value: boolean) {
        this.record.selectFolderEnabled = value;
        return this;
      }
      setIncludeFolders(value: boolean) {
        this.record.includeFolders = value;
        return this;
      }
      setMimeTypes(value: string) {
        this.record.mimeTypes = value;
        return this;
      }
      setEnableDrives(value: boolean) {
        this.record.enableDrives = value;
        return this;
      }
      setMode(value: unknown) {
        this.record.mode = value;
        return this;
      }
    },
    PickerBuilder: class {
      setOAuthToken() {
        return this;
      }
      setDeveloperKey() {
        return this;
      }
      setAppId() {
        return this;
      }
      setTitle() {
        return this;
      }
      enableFeature(feature: unknown) {
        features.push(feature);
        return this;
      }
      addView() {
        return this;
      }
      setCallback(next: (data: unknown) => void) {
        callback = next;
        return this;
      }
      build() {
        return {
          setVisible(next: boolean) {
            visible = next;
          }
        };
      }
    }
  };

  (window as unknown as { google: unknown }).google = { picker: namespace };
  return {
    views,
    features,
    pick: (docs: unknown[]) => callback?.({ action: 'picked', docs }),
    cancel: () => callback?.({ action: 'cancel' }),
    isVisible: () => visible
  };
}

/**
 * Opens the chooser and waits for it to be on screen.
 *
 * `openFolderPicker` resolves the loader before it builds anything, so a choice made in the
 * same turn would arrive before there is a callback to receive it.
 */
async function open(input: { multiple?: boolean } = {}) {
  const fake = fakePicker();
  const opened = openFolderPicker({
    accessToken: 'token',
    config: CONFIG,
    title: 'Choose',
    ...input
  });
  await vi.waitFor(() => expect(fake.isVisible()).toBe(true));
  return { fake, opened };
}

afterEach(() => {
  delete (window as unknown as { google?: unknown }).google;
  vi.restoreAllMocks();
});

describe('the folder chooser', () => {
  it('shows My Drive as it is organised, not every folder in one flat heap', async () => {
    const { fake, opened } = await open();
    fake.pick([{ id: 'campaigns', name: 'Campaigns' }]);
    await opened;

    for (const view of fake.views) {
      // `FOLDERS` lists every folder the account owns at every depth in one pile, which tells
      // a person nothing about which of their two "Creatives" is theirs.
      expect(view.viewId).toBe('docs');
      expect(view.includeFolders).toBe(true);
      // Files are kept out: they could never be chosen here anyway.
      expect(view.mimeTypes).toBe('application/vnd.google-apps.folder');
      // And a folder in that listing is the thing being chosen, not only a door to open.
      expect(view.selectFolderEnabled).toBe(true);
    }
  });

  it('asks for the list rather than a grid of blanks', async () => {
    const { fake, opened } = await open();
    fake.cancel();
    await opened;
    // A `drive.file` app was never granted the thumbnails a grid is made of; Google's own
    // guidance for this scope is the detailed list.
    expect(fake.views.map(view => view.mode)).toEqual(['list', 'list']);
  });

  it('leaves the shared-drives tab at its own top level', async () => {
    const { fake, opened } = await open();
    fake.cancel();
    await opened;

    // Two views on purpose: one lists My Drive or the shared drives, never both, and a single
    // view with drives enabled opened on "Shared drives" alone — where anyone without a
    // Workspace drive saw "No folders." and could pick nothing.
    expect(fake.views).toHaveLength(2);
    const [myDrive, sharedDrives] = fake.views;
    expect(myDrive?.enableDrives).toBe(false);
    expect(sharedDrives?.enableDrives).toBe(true);

  });

  it('asks for more than one folder only when the caller wants more than one', async () => {
    const single = await open();
    single.fake.cancel();
    await single.opened;
    expect(single.fake.features).not.toContain('multi');

    const many = await open({ multiple: true });
    many.fake.cancel();
    await many.opened;
    expect(many.fake.features).toContain('multi');
  });

  it('takes itself off the screen once a choice is made', async () => {
    const { fake, opened } = await open();
    expect(fake.isVisible()).toBe(true);
    fake.pick([{ id: 'campaigns', name: 'Campaigns', resourceKey: 'key-1' }]);
    const picked = await opened;
    // It used to sit over the page while the app worked, hiding whatever the app had to say.
    expect(fake.isVisible()).toBe(false);
    expect(picked).toEqual([
      { id: 'campaigns', name: 'Campaigns', mimeType: null, resourceKey: 'key-1' }
    ]);
  });

  it('reports a cancel as a cancel rather than as an empty choice', async () => {
    const { fake, opened } = await open();
    fake.cancel();
    // Null, not []: "changed my mind" and "chose nothing" lead to different sentences.
    await expect(opened).resolves.toBeNull();
  });

  it('refuses to open at all without the site’s chooser keys', async () => {
    await expect(
      openFolderPicker({ accessToken: 'token', config: null, title: 'Choose' })
    ).rejects.toBeInstanceOf(PickerUnavailableError);
  });
});
