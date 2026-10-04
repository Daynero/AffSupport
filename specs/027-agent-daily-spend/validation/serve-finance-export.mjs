import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const beta = Object.fromEntries(
  readFileSync(new URL('../../../.env.beta', import.meta.url), 'utf8')
    .split('\n')
    .filter(line => /^[A-Z_]+=/.test(line))
    .map(line => {
      const separator = line.indexOf('=');
      return [
        line.slice(0, separator),
        line
          .slice(separator + 1)
          .trim()
          .replace(/^['"]|['"]$/g, '')
      ];
    })
);
if (beta.VITE_SUPABASE_URL !== 'http://127.0.0.1:54321' || beta.VITE_LOCAL_DEV_AUTH !== 'false')
  throw new Error('ISOLATED_REAL_BETA_AUTH_REQUIRED');
const key = beta.VITE_SUPABASE_PUBLISHABLE_KEY ?? beta.VITE_SUPABASE_ANON_KEY;
if (!key) throw new Error('LOCAL_PUBLIC_KEY_REQUIRED');
const child = spawn(
  'npx',
  [
    '--yes',
    'deno',
    'run',
    '--allow-net=127.0.0.1:54321,127.0.0.1:54329',
    '--allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,WISHLY_SITE_URL,NODE_ENV',
    fileURLToPath(new URL('./serve-finance-export.ts', import.meta.url))
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      SUPABASE_URL: beta.VITE_SUPABASE_URL,
      SUPABASE_ANON_KEY: key,
      WISHLY_SITE_URL: 'http://127.0.0.1:5175',
      NODE_ENV: 'test'
    }
  }
);
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => {
  process.exitCode = code ?? 1;
});
