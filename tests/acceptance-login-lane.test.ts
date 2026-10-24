import { beforeEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
const output = vi.hoisted(() => ({ html: '' }));
vi.mock('node:fs/promises', async original => ({
  ...(await original<Record<string, unknown>>()),
  writeFile: async (_path: unknown, html: string) => {
    output.html = html;
  }
}));
import { prepareLoginPage } from '../scripts/acceptance/login-page.mjs';
const namespace = 'acceptance-login-test';
const target = {
  kind: 'local',
  environment: 'beta',
  marker: 'soty-acceptance',
  namespace,
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:synthetic@127.0.0.1:54322/postgres'
};
beforeEach(() => {
  output.html = '';
});
async function page(options: { laneFails?: boolean; email?: string; localDev?: boolean } = {}) {
  await prepareLoginPage(target);
  const script = /<script type="module">([\s\S]+)<\/script>/u
    .exec(output.html)![1]
    .replace(/^import .*;$/gmu, '')
    .replaceAll('import.meta.env', 'env');
  const callbacks = new Map<string, (event: unknown) => Promise<void>>();
  const status = { textContent: '' };
  const form = {
    addEventListener: (_event: string, callback: (event: unknown) => Promise<void>) =>
      callbacks.set('submit', callback),
    remove: vi.fn()
  };
  const button = {
    addEventListener: (_event: string, callback: (event: unknown) => Promise<void>) =>
      callbacks.set('current', callback),
    remove: vi.fn()
  };
  let held = false;
  const sdkCalls: boolean[] = [];
  const signIn = vi.fn(async () => {
    sdkCalls.push(held);
    return { data: { user: { id: 'synthetic-id' } }, error: null };
  });
  const mutate = vi.fn(async (_scope: string, run: () => Promise<unknown>) => {
    if (options.laneFails) throw Error('synthetic state unavailable');
    held = true;
    try {
      return await run();
    } finally {
      held = false;
    }
  });
  const redirect = vi.fn(),
    capture = vi.fn();
  runInNewContext(
    script,
    {
      env: {
        DEV: true,
        VITE_APP_ENVIRONMENT: 'beta',
        VITE_LOCAL_DEV_AUTH: options.localDev ? 'true' : 'false',
        VITE_MOCK_DATA: 'false'
      },
      document: {
        querySelector: (selector: string) =>
          selector === 'form' ? form : selector === '#current-session' ? button : status
      },
      location: { origin: 'http://127.0.0.1:5175', replace: redirect },
      sessionStorage: { setItem: capture },
      publicConfig: { ok: true, value: { supabaseUrl: 'http://127.0.0.1:54321' } },
      getSupabaseClient: () => ({
        auth: {
          signInWithPassword: signIn,
          getUser: async () => ({ data: { user: { id: 'synthetic-id' } }, error: null })
        }
      }),
      acceptanceActorAllowed: () => true,
      runAuthSessionMutation: mutate,
      FormData: class {
        get(key: string) {
          return key === 'email'
            ? (options.email ?? `${namespace}-x@soty.invalid`)
            : 'synthetic-password';
        }
      }
    },
    { timeout: 1000 }
  );
  return { callbacks, status, form, sdkCalls, signIn, mutate, redirect, capture };
}
it('commits the synthetic login inside the actual product lane interface', async () => {
  const p = await page();
  await p.callbacks.get('submit')!({ preventDefault() {}, currentTarget: {} });
  expect(p.sdkCalls).toEqual([true]);
  expect(p.mutate).toHaveBeenCalledWith('http://127.0.0.1:54321', expect.any(Function));
  expect(p.redirect).toHaveBeenCalledWith('/');
});
it('shows a closed error when the lane refuses and makes no SDK call', async () => {
  const p = await page({ laneFails: true });
  await p.callbacks.get('submit')!({ preventDefault() {}, currentTarget: {} });
  expect(p.signIn).not.toHaveBeenCalled();
  expect(p.redirect).not.toHaveBeenCalled();
  expect(p.status.textContent).toBe('Sign-in could not finish');
});
it('refuses a non-campaign address before changing the current session', async () => {
  const p = await page({ email: 'real@example.test' });
  await p.callbacks.get('submit')!({ preventDefault() {}, currentTarget: {} });
  expect(p.signIn).not.toHaveBeenCalled();
  expect(p.mutate).not.toHaveBeenCalled();
});
it('does not enable a fixture login against fake local development auth', async () => {
  const p = await page({ localDev: true });
  expect(p.form.remove).toHaveBeenCalled();
  expect(p.callbacks.has('submit')).toBe(false);
});
