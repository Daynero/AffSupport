import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { TRANSCRIBE_EXTENSIONS } from '@video-compressor/shared';
import { powerShellQuote as psQuote, windowsPowerShell } from '../platform/platform.js';
import { pathGrants, type GrantAccess } from './path-grants.js';

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
      'Could not open the native file picker.'
    );
  }
  const script =
    'set chosenFiles to choose file with prompt "Select videos to compress" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the native file picker.');
}

export async function selectTranscribeMedia(): Promise<string[]> {
  if (process.platform === 'win32') {
    return runWindowsPicker(
      windowsOpenFileScript(
        'Select audio or video to transcribe',
        windowsFilter('Audio and video', TRANSCRIBE_EXTENSIONS)
      ),
      'Could not open the native file picker.'
    );
  }
  const script =
    'set chosenFiles to choose file with prompt "Select audio or video to transcribe" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the native file picker.');
}

export async function selectLandingZips(): Promise<string[]> {
  if (process.platform === 'win32') {
    return runWindowsPicker(
      windowsOpenFileScript('Select landing ZIP archives', windowsFilter('ZIP archives', ['.zip'])),
      'Could not open the archive picker.'
    );
  }
  const script =
    'set chosenFiles to choose file with prompt "Select landing ZIP archives" of type {"zip", "public.zip-archive"} with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the archive picker.');
}

export async function selectLandingFolders(): Promise<string[]> {
  if (process.platform === 'win32') {
    // FolderBrowserDialog cannot multi-select; one folder per invocation is
    // still a working flow because the landing routes accept a single folder.
    const folders = await runWindowsPicker(
      windowsFolderScript('Choose a landing folder'),
      'Could not open the folder picker.'
    );
    return folders.slice(0, 1);
  }
  const script =
    'set chosenFolders to choose folder with prompt "Choose landing folders" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFolders\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the folder picker.');
}

/** Selects one catalogue root whose descendant folders/ZIPs contain landings. */
export async function selectLandingPreviewFolder(): Promise<string | null> {
  if (process.platform === 'win32') {
    const folders = await runWindowsPicker(
      windowsFolderScript('Choose a folder that contains landings'),
      'Could not open the folder picker.'
    );
    return folders[0] ?? null;
  }
  const script =
    'POSIX path of (choose folder with prompt "Choose a folder that contains landings")';
  return runFolderScript(script, 'Could not open the folder picker.');
}

/** Folder intake never receives a caller-provided path: this dialog is the authority. */
export async function selectDirectoryIntakeFolder(): Promise<string | null> {
  if (process.platform === 'win32') {
    const folders = await runWindowsPicker(
      windowsFolderScript('Choose a folder to add to the team workspace'),
      'Could not open the folder picker.'
    );
    return folders[0] ?? null;
  }
  const script =
    'POSIX path of (choose folder with prompt "Choose a folder to add to the team workspace")';
  return runFolderScript(script, 'Could not open the folder picker.');
}

// Rapid repeat clicks on the folder button must not stack native dialogs:
// while one picker is open, every additional request joins its promise.
let activeFolderPick: Promise<string | null> | null = null;

export function selectOutputFolder(): Promise<string | null> {
  if (activeFolderPick) return activeFolderPick;
  activeFolderPick = selectOutputFolderNative().finally(() => {
    activeFolderPick = null;
  });
  return activeFolderPick;
}

async function selectOutputFolderNative(): Promise<string | null> {
  if (process.platform === 'win32') {
    const folders = await runWindowsPicker(
      windowsFolderScript('Choose output folder'),
      'Could not choose an output folder.'
    );
    return folders[0] ?? null;
  }
  const script = 'POSIX path of (choose folder with prompt "Choose output folder")';
  return runFolderScript(script, 'Could not choose an output folder.');
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

function runWindowsPicker(script: string, failure: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        windowsPowerShell(),
        ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
        { shell: false, windowsHide: true }
      );
    } catch {
      reject(new Error('NATIVE_PICKER_UNAVAILABLE'));
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('NATIVE_PICKER_TIMEOUT')));
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
    child.on('error', () => finish(() => reject(new Error('NATIVE_PICKER_UNAVAILABLE'))));
    child.on('close', code => {
      out += outputDecoder.end();
      err = (err + errorDecoder.end()).slice(-4000);
      finish(() => {
        if (code === 0) {
          resolve(
            grantChosen(
              out
                .split(/\r?\n/u)
                .map(value => value.trim())
                .filter(Boolean)
            )
          );
        } else reject(new Error('NATIVE_PICKER_UNAVAILABLE', { cause: err.trim() || failure }));
      });
    });
  });
}

function runMultiplePicker(script: string, failure: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { shell: false });
    let out = '',
      err = '';
    child.stdout.on('data', d => {
      out += d;
    });
    child.stderr.on('data', d => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(
          grantChosen(
            out
              .split('\n')
              .map(value => value.trim().replace(/\/$/, ''))
              .filter(Boolean)
          )
        );
      } else if (canceledByUser(err)) resolve([]);
      else reject(new Error(failure));
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

function runFolderScript(script: string, failure: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { shell: false });
    let out = '',
      err = '';
    child.stdout.on('data', d => {
      out += d;
    });
    child.stderr.on('data', d => {
      err += d;
    });
    child.on('close', code =>
      code === 0
        ? // A folder is chosen to write into as often as to read from, so the
          // grant covers both; a read-only grant here would refuse the output
          // directory the user just picked.
          resolve(grantChosen([out.trim().replace(/\/$/, '')], 'write')[0] ?? null)
        : canceledByUser(err)
          ? resolve(null)
          : reject(new Error(failure))
    );
    child.on('error', reject);
  });
}
