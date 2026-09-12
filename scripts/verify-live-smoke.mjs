#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import {
  releaseManifestSigningPayload,
  RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64
} from '../packages/shared/dist/release.js';
import { activeBinding } from './lib/release/bindings.mjs';
import {
  firstAssetPath,
  manifestAgreement,
  oauthStartProblems,
  shellProblems,
  spaRouteProblems,
  summarize
} from './lib/live-smoke.mjs';

/**
 * Does the deployed thing work, asked of the deployed thing.
 *
 * Everything else in this repository verifies what was built. This verifies what
 * is being served, from outside, the way a user meets it: the shell loads, its
 * bundle exists, a deep link is not a 404, the update manifest the desktop app
 * reads is the one this release signed and still carries a valid signature, the
 * identity handshake reaches Google, and the server-side functions answer.
 *
 * It is the ten manual steps of docs/PRODUCTION.md, minus the ones that need a
 * real account, performed in about three seconds. That difference matters more
 * than the coverage does: a check a person runs when they remember is a check
 * that was not running the night production stayed down for hours.
 *
 * Usage:
 *   node scripts/verify-live-smoke.mjs [--json]
 *
 * The Supabase probes need the publishable key — a public value, the same one
 * the bundle ships. It is read from the build environment, or from
 * SOTY_SMOKE_SUPABASE_KEY when this runs somewhere without one.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');
/**
 * The heartbeat runs from the default branch on a schedule, where the repository
 * can legitimately be one manifest commit ahead of what is deployed. Comparing
 * the two there would turn a normal release window into a standing alarm, and an
 * alarm that is usually wrong is an alarm nobody reads. Release runs keep the
 * comparison — it is the whole point there — and the heartbeat asks only whether
 * what is served is a valid, signed manifest.
 */
const servedOnly = process.argv.includes('--served-only');
const TIMEOUT_MS = 15_000;

const binding = activeBinding();
const origin = binding.siteOrigin;
const supabaseUrl = `https://${binding.supabaseProject}.supabase.co`;
const publishableKey =
  process.env.SOTY_SMOKE_SUPABASE_KEY?.trim() ||
  loadEnv('production', root, '').VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  '';

/** @type {{name: string, problems: string[]}[]} */
const checks = [];
const add = (name, problems) => checks.push({ name, problems });

/**
 * @param {string} url
 * @param {{headers?: Record<string, string>, redirect?: RequestRedirect}} [options]
 */
async function get(url, { headers = {}, redirect = 'follow' } = {}) {
  const response = await fetch(url, {
    headers,
    redirect,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    location: response.headers.get('location') ?? '',
    body: await response.text()
  };
}

/** A probe that throws has not passed; it has failed to answer, which is worse. */
async function probe(name, run) {
  try {
    add(name, await run());
  } catch (error) {
    add(name, [
      `could not be checked: ${error instanceof Error ? error.message : 'unknown error'}`
    ]);
  }
}

// --- the page a person lands on -------------------------------------------
let shellHtml = '';
await probe('shell', async () => {
  const response = await get(`${origin}/`);
  shellHtml = response.body;
  if (response.status !== 200) return [`${origin}/ answered HTTP ${response.status}`];
  return shellProblems(response.body);
});

await probe('bundle', async () => {
  const asset = firstAssetPath(shellHtml);
  if (!asset) return ['no built asset to load, because the shell referenced none'];
  const response = await get(`${origin}${asset}`);
  return response.status === 200 ? [] : [`${asset} answered HTTP ${response.status}`];
});

// --- the deep link that a missing SPA rule turns into a 404 ----------------
await probe('spa-route', async () =>
  spaRouteProblems(await get(`${origin}/compressor`), '/compressor')
);

// --- the manifest every installed desktop app polls ------------------------
await probe('update-manifest', async () => {
  const response = await get(`${origin}/.well-known/wishly/stable.json`);
  if (response.status !== 200) return [`the update manifest answered HTTP ${response.status}`];
  let live;
  try {
    live = JSON.parse(response.body);
  } catch {
    return ['the update manifest is not valid JSON'];
  }
  const problems = servedOnly
    ? live.signature
      ? []
      : ['the served manifest carries no signature']
    : manifestAgreement(
        live,
        JSON.parse(
          readFileSync(path.join(root, 'apps/web/public/.well-known/wishly/stable.json'), 'utf8')
        )
      );
  if (live.signature) {
    const key = await webcrypto.subtle.importKey(
      'spki',
      Buffer.from(RELEASE_MANIFEST_PUBLIC_KEY_SPKI_B64, 'base64'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const valid = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(live.signature.replaceAll('-', '+').replaceAll('_', '/'), 'base64'),
      new TextEncoder().encode(releaseManifestSigningPayload(live))
    );
    // Every installed app refuses an unsigned or wrongly signed manifest, so a
    // bad signature here is every user silently stuck on their current version.
    if (!valid)
      problems.push('the served manifest signature does not verify against the release key');
  }
  return problems;
});

// --- the database and identity the browser talks to ------------------------
if (!publishableKey) {
  add('supabase', [
    'no publishable key available, so the database and identity probes could not run — ' +
      'set SOTY_SMOKE_SUPABASE_KEY or provide a production build environment'
  ]);
} else {
  const apikey = { apikey: publishableKey, Authorization: `Bearer ${publishableKey}` };

  await probe('auth-health', async () => {
    const response = await get(`${supabaseUrl}/auth/v1/health`, { headers: apikey });
    return response.status === 200 ? [] : [`auth answered HTTP ${response.status}`];
  });

  await probe('auth-providers', async () => {
    const response = await get(`${supabaseUrl}/auth/v1/settings`, { headers: apikey });
    if (response.status !== 200) return [`auth settings answered HTTP ${response.status}`];
    const settings = JSON.parse(response.body);
    return settings?.external?.google === true
      ? []
      : ['the Google identity provider is not enabled'];
  });

  await probe('oauth-start', async () =>
    oauthStartProblems(
      await get(
        `${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`${origin}/auth/callback`)}`,
        { headers: apikey, redirect: 'manual' }
      )
    )
  );

  await probe('functions', async () => {
    const response = await get(`${supabaseUrl}/functions/v1/drive-connect/readiness`, {
      headers: { ...apikey, origin }
    });
    if (response.status !== 200) return [`the deployed functions answered HTTP ${response.status}`];
    const payload = JSON.parse(response.body);
    // Whether every feature is switched on is verify-team-production's question.
    // This one asks only whether the server-side surface is alive at all.
    return payload?.ok === true ? [] : ['the deployed readiness endpoint reports a failure'];
  });
}

const result = {
  ...summarize(checks),
  origin,
  project: binding.supabaseProject,
  checkedAt: new Date().toISOString()
};

if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else if (!result.ok)
  process.stderr.write(`Live smoke failed (${origin}):\n  ${result.failures.join('\n  ')}\n`);
else process.stdout.write(`Live smoke passed: ${result.checked} checks against ${origin}.\n`);

process.exit(result.ok ? 0 : 1);
