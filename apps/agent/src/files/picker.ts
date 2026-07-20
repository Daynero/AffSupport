import { spawn } from 'node:child_process';

export async function selectVideos(): Promise<string[]> {
  const script =
    'set chosenFiles to choose file with prompt "Select videos to compress" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { shell: false });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', d => {
      stdout += d;
    });
    child.stderr.on('data', d => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0)
        resolve(
          stdout
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
        );
      else if (stderr.includes('User canceled')) resolve([]);
      else reject(new Error('Could not open the native file picker.'));
    });
  });
}

export async function selectLandingZips(): Promise<string[]> {
  const script =
    'set chosenFiles to choose file with prompt "Select landing ZIP archives" of type {"zip", "public.zip-archive"} with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the archive picker.');
}

export async function selectLandingFolders(): Promise<string[]> {
  const script =
    'set chosenFolders to choose folder with prompt "Choose landing folders" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFolders\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return runMultiplePicker(script, 'Could not open the folder picker.');
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
          out
            .split('\n')
            .map(value => value.trim().replace(/\/$/, ''))
            .filter(Boolean)
        );
      } else if (err.includes('User canceled')) resolve([]);
      else reject(new Error(failure));
    });
  });
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
    child.on('error', reject);
    child.on('close', code =>
      code === 0
        ? resolve(out.trim().replace(/\/$/, ''))
        : err.includes('User canceled')
          ? resolve(null)
          : reject(new Error(failure))
    );
  });
}

export async function selectOutputFolder(): Promise<string | null> {
  const script = 'POSIX path of (choose folder with prompt "Choose output folder")';
  return runFolderScript(script, 'Could not choose an output folder.');
}
