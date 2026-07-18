import { spawn } from 'node:child_process';

export async function selectVideos(): Promise<string[]> {
  const script = 'set chosenFiles to choose file with prompt "Select videos to compress" with multiple selections allowed\nset out to ""\nrepeat with f in chosenFiles\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out';
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.split('\n').map(s => s.trim()).filter(Boolean));
      else if (stderr.includes('User canceled')) resolve([]);
      else reject(new Error('Could not open the native file picker.'));
    });
  });
}

export async function selectOutputFolder(): Promise<string | null> {
  const script = 'POSIX path of (choose folder with prompt "Choose output folder")';
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { shell: false }); let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(out.trim().replace(/\/$/, '')) : err.includes('User canceled') ? resolve(null) : reject(new Error('Could not choose an output folder.')));
  });
}
