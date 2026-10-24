import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { TRANSCRIBE_EXTENSIONS } from '@video-compressor/shared';
import { powerShellQuote as psQuote, windowsPowerShell } from '../platform/platform.js';
import { pathGrants, type GrantAccess } from './path-grants.js';
import { diagnostics } from '../server/diagnostics-log.js';

/**
 * Native pickers per platform: osascript `choose file/folder` on macOS,
 * PowerShell WinForms dialogs on Windows (capabilities().nativeFilePicker
 * gates the routes that call these). Both variants resolve to [] / null when
 * the user cancels and reject only on real failures.
 *
 * The PowerShell branch is covered by unit tests with a stubbed spawn; the
 * dialogs themselves can only be exercised live on a Windows machine
 * (docs/WINDOWS.md tracks that verification).
 */

interface NativePickerChild {
  child: ChildProcess;
  interrupted: boolean;
  closed: Promise<void>;
}
const nativePickerChildren = new Set<NativePickerChild>();
let stoppingNativePickers = false;

function trackNativePicker(child: ChildProcess, signal?: AbortSignal): NativePickerChild {
  let complete: () => void = () => {};
  const closed = new Promise<void>(resolve => {
    complete = resolve;
  });
  const tracked = { child, interrupted: false, closed };
  nativePickerChildren.add(tracked);
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    tracked.interrupted = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* Already exited. */
    }
    escalation = setTimeout(() => {
      if (nativePickerChildren.has(tracked)) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }, 1000);
    escalation.unref();
  };
  const finished = () => {
    signal?.removeEventListener('abort', interrupt);
    if (escalation) clearTimeout(escalation);
    nativePickerChildren.delete(tracked);
    complete();
  };
  child.once('close', finished);
  child.once('error', finished);
  signal?.addEventListener('abort', interrupt, { once: true });
  if (signal?.aborted) interrupt();
  return tracked;
}

async function waitForPickerExit(children: NativePickerChild[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(children.map(entry => entry.closed)),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Dialogs are not governed media workers, but must still end before their agent exits. */
export async function shutdownNativePickers(): Promise<void> {
  stoppingNativePickers = true;
  const children = [...nativePickerChildren];
  if (!children.length) return;
  for (const entry of children) {
    entry.interrupted = true;
    try {
      entry.child.kill('SIGTERM');
    } catch {
      /* The child may already have exited. */
    }
  }
  await waitForPickerExit(children, 1000);
  const remaining = children.filter(entry => nativePickerChildren.has(entry));
  for (const entry of remaining) {
    try {
      entry.child.kill('SIGKILL');
    } catch {
      /* Already gone between checks. */
    }
  }
  if (remaining.length) await waitForPickerExit(remaining, 500);
}

/** Keep in sync with SUPPORTED_VIDEO_EXTENSIONS in queue/queue.ts. */
const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.m4v',
  '.mkv',
  '.webm',
  '.avi',
  '.mpg',
  '.mpeg',
  '.mts',
  '.m2ts'
];

// A native dialog may legitimately stay open while someone browses. Two minutes
// still bounds the request when Windows starts PowerShell without ever showing
// the dialog (policy, security software, or a broken interactive desktop).
const WINDOWS_PICKER_TIMEOUT_MS = 120_000;

export async function selectVideos(): Promise<string[]> {
  if (process.platform === 'win32') {
    return runWindowsPicker(
      windowsOpenFileScript('Select videos to compress', windowsFilter('Videos', VIDEO_EXTENSIONS)),
      'Could not open the native file picker.',
      'videos'
    );
  }
  const script =
    'set chosenFiles to choose file with prompt "Select videos to compress" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the native file picker.', 'videos');
}

export async function selectTranscribeMedia(): Promise<string[]> {
  if (process.platform === 'win32') {
    return runWindowsPicker(
      windowsOpenFileScript(
        'Select audio or video to transcribe',
        windowsFilter('Audio and video', TRANSCRIBE_EXTENSIONS)
      ),
      'Could not open the native file picker.',
      'media'
    );
  }
  const script =
    'set chosenFiles to choose file with prompt "Select audio or video to transcribe" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the native file picker.', 'media');
}

export async function selectLandingZips(): Promise<string[]> {
  if (process.platform === 'win32') {
    return runWindowsPicker(
      windowsOpenFileScript('Select landing ZIP archives', windowsFilter('ZIP archives', ['.zip'])),
      'Could not open the archive picker.',
      'archives'
    );
  }
  const script =
    'set chosenFiles to choose file with prompt "Select landing ZIP archives" of type {"zip", "public.zip-archive"} with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the archive picker.', 'archives');
}

export async function selectLandingFolders(): Promise<string[]> {
  if (process.platform === 'win32') {
    // FolderBrowserDialog cannot multi-select; one folder per invocation is
    // still a working flow because the landing routes accept a single folder.
    const folders = await runWindowsPicker(
      windowsFolderScript('Choose a landing folder'),
      'Could not open the folder picker.',
      'landing_folders'
    );
    return folders.slice(0, 1);
  }
  const script =
    'set chosenFolders to choose folder with prompt "Choose landing folders" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFolders\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the folder picker.', 'landing_folders');
}

/** Selects one catalogue root whose descendant folders/ZIPs contain landings. */
export async function selectLandingPreviewFolder(): Promise<string | null> {
  if (process.platform === 'win32') {
    const folders = await runWindowsPicker(
      windowsFolderScript('Choose a folder that contains landings'),
      'Could not open the folder picker.',
      'landing_preview_folder'
    );
    return folders[0] ?? null;
  }
  const script =
    'POSIX path of (choose folder with prompt "Choose a folder that contains landings")';
  return runFolderScript(script, 'Could not open the folder picker.', 'landing_preview_folder');
}

/** Folder intake never receives a caller-provided path: this dialog is the authority. */
export async function selectDirectoryIntakeFolder(): Promise<string | null> {
  if (process.platform === 'win32') {
    const folders = await runWindowsPicker(
      windowsFolderScript('Choose a folder to add to the team workspace'),
      'Could not open the folder picker.',
      'intake_folder'
    );
    return folders[0] ?? null;
  }
  const script =
    'POSIX path of (choose folder with prompt "Choose a folder to add to the team workspace")';
  return runFolderScript(script, 'Could not open the folder picker.', 'intake_folder');
}

// Rapid repeat clicks on the folder button must not stack native dialogs:
// while one picker is open, every additional request joins its promise.
interface OutputFolderPick {
  promise: Promise<string | null>;
  controller: AbortController;
  waiters: number;
  done: boolean;
}
let activeFolderPick: OutputFolderPick | null = null;

export function selectOutputFolder(signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (!activeFolderPick || activeFolderPick.controller.signal.aborted) {
    const pick: OutputFolderPick = {
      promise: Promise.resolve(null),
      controller: new AbortController(),
      waiters: 0,
      done: false
    };
    pick.promise = selectOutputFolderNative(pick.controller.signal).finally(() => {
      pick.done = true;
      if (activeFolderPick === pick) activeFolderPick = null;
    });
    activeFolderPick = pick;
  }
  const pick = activeFolderPick;
  pick.waiters += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener('abort', abort);
      pick.waiters -= 1;
      // One caller leaving cannot dismiss another caller's shared dialog.
      if (!pick.waiters && !pick.done) pick.controller.abort();
      return true;
    };
    const abort = () => {
      if (release()) resolve(null);
    };
    signal?.addEventListener('abort', abort, { once: true });
    pick.promise.then(
      value => {
        if (release()) resolve(value);
      },
      error => {
        if (release()) reject(error);
      }
    );
  });
}

async function selectOutputFolderNative(signal: AbortSignal): Promise<string | null> {
  if (process.platform === 'win32') {
    const folders = await runWindowsPicker(
      windowsFolderScript('Choose output folder'),
      'Could not choose an output folder.',
      'output_folder',
      signal
    );
    return folders[0] ?? null;
  }
  const script = 'POSIX path of (choose folder with prompt "Choose output folder")';
  return runFolderScript(script, 'Could not choose an output folder.', 'output_folder', signal);
}

/** `Videos (*.mp4;*.mov)|*.mp4;*.mov|All files (*.*)|*.*` — WinForms filter syntax. */
function windowsFilter(label: string, extensions: readonly string[]): string {
  const patterns = extensions.map(extension => `*${extension}`).join(';');
  return `${label} (${patterns})|${patterns}|All files (*.*)|*.*`;
}

/**
 * Multi-select OpenFileDialog. Cancel prints nothing and exits 0, matching the
 * macOS "User canceled" → [] semantics; a non-zero exit means a real failure.
 */
/**
 * An invisible, topmost owner for the dialog.
 *
 * Without an owner the dialog is a plain top-level window of a process the user
 * never clicked, and Windows will not bring it to the front: it opens behind
 * Chrome, the user sees nothing, and two minutes later the request times out.
 * Owned by a topmost window, the dialog is topmost too.
 *
 * The owner is shown, not just created. The agent starts PowerShell with its
 * console hidden, which Windows records in the process's STARTUPINFO — and the
 * first ShowWindow call a process makes ignores its own argument and uses that
 * recorded state instead. Shown first, this one-pixel transparent form absorbs
 * that call, so the dialog's own show is honoured. Centred, so the dialog that
 * centres on its owner lands mid-screen.
 */
function windowsDialogOwner(): string[] {
  return [
    '$owner = New-Object System.Windows.Forms.Form',
    "$owner.FormBorderStyle = 'None'",
    "$owner.StartPosition = 'CenterScreen'",
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$owner.Opacity = 0',
    '$owner.ShowInTaskbar = $false',
    '$owner.TopMost = $true',
    '$owner.Show()'
  ];
}

function windowsOpenFileScript(title: string, filter: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing | Out-Null',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = ${psQuote(title)}`,
    `$dialog.Filter = ${psQuote(filter)}`,
    '$dialog.Multiselect = $true',
    '$dialog.CheckFileExists = $true',
    ...windowsDialogOwner(),
    'try {',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  foreach ($file in $dialog.FileNames) { [Console]::Out.WriteLine($file) }',
    '}',
    '} finally { $dialog.Dispose(); $owner.Dispose() }'
  ].join('\n');
}

function windowsFolderScript(description: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing | Out-Null',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = ${psQuote(description)}`,
    '$dialog.ShowNewFolderButton = $true',
    ...windowsDialogOwner(),
    'try {',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.WriteLine($dialog.SelectedPath)',
    '}',
    '} finally { $dialog.Dispose(); $owner.Dispose() }'
  ].join('\n');
}

/**
 * Runs a dialog script in Windows PowerShell. -STA is required for WinForms
 * dialogs; -NonInteractive only blocks console prompts, not GUI windows;
 * windowsHide suppresses the transient console window, not the dialog.
 */

/**
 * Records what the user just chose, and hands the paths back unchanged.
 *
 * Every selector funnels through the three runners below, so minting here means
 * a selector added later inherits the grant without its author having to know
 * the ledger exists — which is the only version of this that stays true. The
 * paths are returned whatever the ledger says: a grant that could not be minted
 * (the path vanished between the dialog and this line, or it is out of bounds)
 * is a path the routes will refuse later, and failing here instead would turn a
 * refusal into a picker that appears broken.
 */
function grantChosen(paths: readonly string[], access: GrantAccess = 'read'): string[] {
  for (const candidate of paths) pathGrants.mint(candidate, { access, origin: 'picker' });
  return [...paths];
}

/**
 * Which dialog this is, for the diagnostics journal (031 FR-054): a closed vocabulary so a
 * support thread can say "the output-folder picker never came back" without the journal
 * ever holding what was chosen in it.
 */
type PickerKind =
  | 'videos'
  | 'media'
  | 'archives'
  | 'landing_folders'
  | 'landing_preview_folder'
  | 'intake_folder'
  | 'output_folder';

type PickerOutcome = 'chosen' | 'cancelled' | 'failed' | 'unavailable' | 'timeout' | 'interrupted';

function journalPickerLaunch(kind: PickerKind, platform: 'windows' | 'macos'): void {
  diagnostics.record('picker', 'launch', { kind, platform });
}

/**
 * One exit record per dialog run. `error` and `close` can both fire for the same child, and
 * the journal should say how the dialog ended once, not twice.
 */
function pickerExitJournal(kind: PickerKind): (outcome: PickerOutcome, chosen?: number) => void {
  let reported = false;
  return (outcome, chosen = 0) => {
    if (reported) return;
    reported = true;
    diagnostics.record('picker', 'exit', { kind, outcome, chosen });
  };
}

function runWindowsPicker(
  script: string,
  failure: string,
  kind: PickerKind,
  signal?: AbortSignal
): Promise<string[]> {
  if (stoppingNativePickers || signal?.aborted) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    journalPickerLaunch(kind, 'windows');
    const exited = pickerExitJournal(kind);
    let child;
    try {
      child = spawn(
        windowsPowerShell(),
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
        { shell: false, windowsHide: true }
      );
    } catch {
      exited('unavailable');
      reject(new Error('NATIVE_PICKER_UNAVAILABLE'));
      return;
    }
    const tracked = trackNativePicker(child, signal);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      // PowerShell started and never came back: the dialog may have opened behind every
      // window or never opened at all, and from here the two are the same fact.
      diagnostics.record('picker', 'visibility_unknown', { kind });
      child.kill();
      finish(() => {
        exited('timeout');
        reject(new Error('NATIVE_PICKER_TIMEOUT'));
      });
    }, WINDOWS_PICKER_TIMEOUT_MS);
    timer.unref();
    let out = '',
      err = '';
    const outputDecoder = new StringDecoder('utf8');
    const errorDecoder = new StringDecoder('utf8');
    child.stdout.on('data', d => {
      out += typeof d === 'string' ? d : outputDecoder.write(d);
    });
    child.stderr.on('data', d => {
      err = (err + (typeof d === 'string' ? d : errorDecoder.write(d))).slice(-4000);
    });
    child.on('error', () =>
      finish(() => {
        if (tracked.interrupted) {
          exited('interrupted');
          resolve([]);
          return;
        }
        exited('unavailable');
        reject(new Error('NATIVE_PICKER_UNAVAILABLE'));
      })
    );
    child.on('close', code => {
      out += outputDecoder.end();
      err = (err + errorDecoder.end()).slice(-4000);
      finish(() => {
        if (tracked.interrupted) {
          exited('interrupted');
          resolve([]);
          return;
        }
        if (code === 0) {
          const chosen = grantChosen(
            out
              .split(/\r?\n/u)
              .map(value => value.trim())
              .filter(Boolean)
          );
          // Cancel prints nothing and exits 0, so an empty selection is the cancel.
          exited(chosen.length ? 'chosen' : 'cancelled', chosen.length);
          resolve(chosen);
        } else {
          exited('failed');
          reject(new Error('NATIVE_PICKER_UNAVAILABLE', { cause: err.trim() || failure }));
        }
      });
    });
  });
}

function runMultiplePicker(script: string, failure: string, kind: PickerKind): Promise<string[]> {
  if (stoppingNativePickers) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    journalPickerLaunch(kind, 'macos');
    const exited = pickerExitJournal(kind);
    const child = spawn('/usr/bin/osascript', ['-e', script], { shell: false });
    const tracked = trackNativePicker(child);
    let out = '',
      err = '';
    child.stdout.on('data', d => {
      out += d;
    });
    child.stderr.on('data', d => {
      err += d;
    });
    child.on('error', error => {
      if (tracked.interrupted) {
        exited('interrupted');
        resolve([]);
        return;
      }
      exited('unavailable');
      reject(error);
    });
    child.on('close', code => {
      if (tracked.interrupted) {
        exited('interrupted');
        resolve([]);
        return;
      }
      if (code === 0) {
        const chosen = grantChosen(
          out
            .split('\n')
            .map(value => value.trim().replace(/\/$/, ''))
            .filter(Boolean)
        );
        exited('chosen', chosen.length);
        resolve(chosen);
      } else if (canceledByUser(err)) {
        exited('cancelled');
        resolve([]);
      } else {
        exited('failed');
        reject(new Error(failure));
      }
    });
  });
}

/**
 * A cancelled AppleScript dialog reports error -128. The message text is
 * localized (macOS in Ukrainian says "Користувач скасував"), so matching the
 * English wording alone turned every cancel into a failure — the code is the
 * part that never changes.
 */
function canceledByUser(stderr: string): boolean {
  return stderr.includes('-128') || stderr.includes('User canceled');
}

function runFolderScript(
  script: string,
  failure: string,
  kind: PickerKind,
  signal?: AbortSignal
): Promise<string | null> {
  if (stoppingNativePickers || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    journalPickerLaunch(kind, 'macos');
    const exited = pickerExitJournal(kind);
    const child = spawn('/usr/bin/osascript', ['-e', script], { shell: false });
    const tracked = trackNativePicker(child, signal);
    let out = '',
      err = '';
    child.stdout.on('data', d => {
      out += d;
    });
    child.stderr.on('data', d => {
      err += d;
    });
    child.on('close', code => {
      if (tracked.interrupted) {
        exited('interrupted');
        resolve(null);
        return;
      }
      if (code === 0) {
        // A folder is chosen to write into as often as to read from, so the
        // grant covers both; a read-only grant here would refuse the output
        // directory the user just picked.
        const chosen = grantChosen([out.trim().replace(/\/$/, '')], 'write')[0] ?? null;
        exited('chosen', chosen ? 1 : 0);
        resolve(chosen);
      } else if (canceledByUser(err)) {
        exited('cancelled');
        resolve(null);
      } else {
        exited('failed');
        reject(new Error(failure));
      }
    });
    child.on('error', error => {
      if (tracked.interrupted) {
        exited('interrupted');
        resolve(null);
        return;
      }
      exited('unavailable');
      reject(error);
    });
  });
}
