/**
 * Google's own folder chooser (feature 011).
 *
 * Under the non-restricted `drive.file` scope Soty cannot list the account's
 * folders itself, so the owner picks the root in Google's chooser. The loader
 * script comes from apis.google.com (allowed by the content policy for exactly
 * this), the chooser renders inside a docs.google.com frame, and the access
 * token it needs is minted server-side and held in memory only.
 */

export interface PickerDocument {
  id: string;
  name: string;
  mimeType: string | null;
  resourceKey: string | null;
}

interface PickerView {
  setSelectFolderEnabled(value: boolean): PickerView;
  setIncludeFolders(value: boolean): PickerView;
  setMimeTypes(value: string): PickerView;
  setEnableDrives?(value: boolean): PickerView;
  setMode?(value: unknown): PickerView;
}

interface PickerResponse {
  action: string;
  docs?: Array<{ id?: unknown; name?: unknown; mimeType?: unknown; resourceKey?: unknown }>;
}

interface PickerBuilder {
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  addView(view: PickerView): PickerBuilder;
  setCallback(callback: (data: PickerResponse) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

export interface PickerNamespace {
  ViewId: { FOLDERS: unknown; DOCS: unknown };
  DocsViewMode?: { LIST: unknown; GRID: unknown };
  Feature: { SUPPORT_DRIVES: unknown; MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
  DocsView: new (viewId?: unknown) => PickerView;
  PickerBuilder: new () => PickerBuilder;
}

declare global {
  interface Window {
    gapi?: { load(name: string, callback: () => void): void };
    google?: { picker?: PickerNamespace };
  }
}

export const PICKER_SCRIPT_URL = 'https://apis.google.com/js/api.js';
const SCRIPT_ID = 'soty-google-picker-loader';
const LOAD_TIMEOUT_MS = 10_000;

export class PickerUnavailableError extends Error {
  readonly code = 'PICKER_UNAVAILABLE';
  constructor() {
    super('PICKER_UNAVAILABLE');
    this.name = 'PickerUnavailableError';
  }
}

let loading: Promise<PickerNamespace> | null = null;

/** Inject the loader once and resolve the picker namespace, or fail in bounded time. */
export function loadPicker(): Promise<PickerNamespace> {
  if (typeof window === 'undefined') return Promise.reject(new PickerUnavailableError());
  if (window.google?.picker) return Promise.resolve(window.google.picker);
  if (loading) return loading;
  loading = new Promise<PickerNamespace>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      loading = null;
      reject(new PickerUnavailableError());
    }, LOAD_TIMEOUT_MS);
    const finish = () => {
      window.gapi?.load('picker', () => {
        window.clearTimeout(timer);
        const picker = window.google?.picker;
        if (picker) resolve(picker);
        else {
          loading = null;
          reject(new PickerUnavailableError());
        }
      });
    };
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener('load', finish, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = PICKER_SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', finish, { once: true });
    script.addEventListener(
      'error',
      () => {
        window.clearTimeout(timer);
        loading = null;
        reject(new PickerUnavailableError());
      },
      { once: true }
    );
    document.head.appendChild(script);
  });
  return loading;
}

export interface PickerConfig {
  apiKey: string;
  appId: string;
}

/** Public browser values; both are required for the chooser to open at all. */
type Env = Record<string, string | boolean | undefined>;

function envValue(env: Env, key: string): string {
  const raw = env[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

export function pickerConfig(env: Env = import.meta.env): PickerConfig | null {
  const apiKey = envValue(env, 'VITE_GOOGLE_PICKER_API_KEY');
  const appId = envValue(env, 'VITE_GOOGLE_PROJECT_NUMBER');
  return apiKey && appId ? { apiKey, appId } : null;
}

export type PickFolders = (input: {
  accessToken: string;
  /** Null when the site has no chooser keys; the real chooser refuses, a test double ignores it. */
  config: PickerConfig | null;
  title: string;
  multiple?: boolean;
}) => Promise<PickerDocument[] | null>;

/** Open the chooser for folders; resolves with the picked folders, or null on cancel. */
export const openFolderPicker: PickFolders = async input => {
  if (!input.config) throw new PickerUnavailableError();
  const config = input.config;
  const picker = await loadPicker();
  return new Promise(resolve => {
    /**
     * One view per tab, and a view either lists My Drive or the shared drives —
     * not both. Configured as a single view with `setEnableDrives(true)` the
     * chooser opened on "Shared drives" alone, so anyone without a Workspace
     * shared drive was shown "No folders." and could not pick anything at all.
     *
     * **`DOCS`, not `FOLDERS`.** `ViewId.FOLDERS` lists every folder the account owns as one
     * flat heap, at every depth, with no sense of where any of them live — which is useless
     * to anyone who has more than a handful and has named two of them "Creatives". `DOCS`
     * with folders included shows My Drive as it is actually organised, so the tree is walked
     * downwards and the folder is picked where it lives. Restricting the MIME types to
     * folders keeps files out of a listing where they could never be chosen anyway.
     *
     * `setParent` is deliberately *not* used to force a starting folder: the documentation
     * says it overrides `setEnableDrives`, which the second view depends on, and it is
     * reported to disable folder selection outright — the one thing this chooser exists for.
     *
     * `LIST` rather than the thumbnail grid because Google says so for exactly our case: a
     * `drive.file` app has not been granted access to thumbnails, so a grid is a grid of
     * blanks.
     */
    const folderView = (sharedDrives: boolean) => {
      const view = new picker.DocsView(picker.ViewId.DOCS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true)
        .setMimeTypes('application/vnd.google-apps.folder');
      view.setEnableDrives?.(sharedDrives);
      if (picker.DocsViewMode) view.setMode?.(picker.DocsViewMode.LIST);
      return view;
    };
    let builder = new picker.PickerBuilder()
      .setOAuthToken(input.accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setTitle(input.title)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      // My Drive first: it is where most people keep the folder they mean.
      .addView(folderView(false))
      .addView(folderView(true));
    if (input.multiple) builder = builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
    /**
     * Google's chooser does not take itself off the screen once a choice is
     * made, so it sat over the page while the app worked — and any message the
     * app had about the choice, including a failure, was behind it.
     */
    let instance: { setVisible: (visible: boolean) => void; dispose?: () => void } | null = null;
    const dismiss = () => {
      try {
        instance?.setVisible(false);
        instance?.dispose?.();
      } catch {
        // A chooser that has already gone is not a problem worth reporting.
      }
    };
    const built = builder
      .setCallback(data => {
        if (data.action === picker.Action.PICKED) {
          dismiss();
          const docs = (data.docs ?? [])
            .filter(doc => typeof doc.id === 'string' && doc.id.length > 0)
            .map(doc => ({
              id: doc.id as string,
              name: typeof doc.name === 'string' && doc.name.length > 0 ? doc.name : 'Folder',
              mimeType: typeof doc.mimeType === 'string' ? doc.mimeType : null,
              resourceKey: typeof doc.resourceKey === 'string' ? doc.resourceKey : null
            }));
          resolve(docs);
        } else if (data.action === picker.Action.CANCEL) {
          dismiss();
          resolve(null);
        }
      })
      .build();
    instance = built;
    built.setVisible(true);
  });
};
