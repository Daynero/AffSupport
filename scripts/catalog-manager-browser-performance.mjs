#!/usr/bin/env node
/** A26 source-scoped, local-only browser benchmark. No installation, product
 * route, backend write, deployment, env-file read or authentication acceptance. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rewriteFixtureImports,
  verifyPaintSamples,
  percentile
} from './lib/catalog-manager-browser-proof.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = Object.fromEntries(
  process.argv.slice(2).map(arg => {
    const at = arg.indexOf('=');
    return at < 0 ? [arg.replace(/^--/u, ''), true] : [arg.slice(2, at), arg.slice(at + 1)];
  })
);
if (!options.execute) {
  process.stdout.write(
    'Prepared only. Explicit --execute --output=/external/empty/path --baseline=702e151 --power-percent=100 required. Uses installed playwright-core/browser only.\n'
  );
  process.exit(0);
}
if (
  typeof options.output !== 'string' ||
  !path.isAbsolute(options.output) ||
  !/^([a-f0-9]{7,40})$/u.test(String(options.baseline ?? '')) ||
  options['power-percent'] !== '100'
)
  throw Error('Explicit external output, baseline commit and declared power 100 required');
const output = path.resolve(options.output);
if (
  output === repo ||
  output.startsWith(repo + path.sep) ||
  (existsSync(output) && readdirSync(output).length)
)
  throw Error(
    'Output must be a new/empty directory outside the worktree; evidence is never overwritten'
  );
if (os.getPriority() < 15) throw Error('Run via nice -n 15');
if (os.freemem() < 2 * 1024 ** 3)
  throw Error('Less than 2 GiB free memory; defer without starting a browser/build');
mkdirSync(output, { recursive: true });
const temporary = path.join(output, 'tmp');
mkdirSync(temporary, { recursive: true });
process.env.TMPDIR = temporary;
process.env.TMP = temporary;
process.env.TEMP = temporary;
// The browser bridge returns the test-only controller's serialized record.
// Shape/paint evidence is verified before latency is accepted.
async function evaluate(page, expression) {
  return page.evaluate(expression);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  }).trim();
const baseline = git('rev-parse', '--verify', `${options.baseline}^{commit}`);
const dialogRelative = 'apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx';
const dialogPath = path.join(repo, dialogRelative);
const before = execFileSync('git', ['show', `${baseline}:${dialogRelative}`], {
  cwd: repo,
  encoding: 'utf8',
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
});
const after = readFileSync(dialogPath, 'utf8');
const sourceFiles = [
  'tests/support/catalog-manager-browser-entry.tsx',
  'tests/support/catalog-manager-performance-harness.tsx',
  'tests/fixtures/catalog-manager-performance.ts'
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map(file => [file, hash(readFileSync(path.join(repo, file)))])
);
const flags = {
  VITE_APP_ENVIRONMENT: 'beta',
  VITE_LOCAL_DEV_AUTH: 'false',
  VITE_CATALOG_VIDEO_VARIANTS: 'true',
  VITE_ANALYTICS_ENABLED: 'false',
  VITE_AGENT_URL: 'http://127.0.0.1:1',
  VITE_SUPABASE_URL: 'http://127.0.0.1:1',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_a26_synthetic_not_a_credential',
  VITE_SITE_URL: 'http://127.0.0.1:5175'
};
/** @type {Record<string, any>} */
const report = {
  status: 'running',
  generatedAt: new Date().toISOString(),
  scope:
    'one historical Dialog file versus working-tree Dialog, common current dependencies/CSS/fixture; NOT whole historical app or semantic beta auth acceptance',
  baselineCommit: baseline,
  afterHead: git('rev-parse', 'HEAD'),
  dirtyStatus: git('status', '--porcelain'),
  dialogHashes: { baselineOriginal: hash(before), after: hash(after) },
  sourceHashes,
  lockDigest: hash(readFileSync(path.join(repo, 'package-lock.json'))),
  stylesheet: path.join('apps/web/src/styles/index.css'),
  publicSyntheticFlags: flags,
  environment: {
    os: os.platform(),
    osRelease: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    totalRam: os.totalmem(),
    initialFreeRam: os.freemem(),
    nice: os.getPriority(),
    viewport: { width: 1440, height: 900 },
    cpuThrottleRate: 1,
    networkThrottle: 'none',
    declaredPowerPercent: 100,
    powerVerification: 'operator declaration; record actual power/AC evidence separately',
    headless: options.headless === true
  },
  warmups: 10,
  samples: 50,
  coldLoads: 10,
  phases: [],
  limitations: [
    'React commits unknown when production Profiler callback is disabled',
    'Renderer Paint/DrawFrame proof is not physical monitor presentation',
    'Same current dependency/CSS graph in both phases; this does not measure historical changes outside CatalogUpdaterDialog',
    'Browser network requests and blocked cross-origin attempts retained separately'
  ]
};
const save = () =>
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
save();
let browser;
try {
  const { build } = await import('vite');
  const { chromium } = await import('playwright-core');
  const executable =
    typeof options['browser-executable'] === 'string'
      ? path.resolve(options['browser-executable'])
      : chromium.executablePath();
  if (!existsSync(executable))
    throw Error(
      'Installed Chromium executable not found; no browser download is permitted. Pass --browser-executable=/existing/path'
    );
  report.environment.browserExecutable = executable;
  // Both builds use the same current production beta config/plugins/CSS. Only
  // the Dialog import is swapped in the generated external baseline harness.
  for (const [phase, source] of [
    ['baseline', before],
    ['after', after]
  ]) {
    const generated = path.join(output, phase, 'generated'),
      dist = path.join(output, phase, 'dist');
    mkdirSync(generated, { recursive: true });
    const frozenDialog = path.join(generated, 'CatalogUpdaterDialog.tsx');
    writeFileSync(frozenDialog, rewriteFixtureImports(source, dialogPath));
    const harnessFile = path.join(repo, sourceFiles[1]);
    const rewrittenHarness = rewriteFixtureImports(
      readFileSync(harnessFile, 'utf8'),
      harnessFile
    ).replaceAll(dialogPath.slice(0, -4), frozenDialog);
    writeFileSync(path.join(generated, 'harness.tsx'), rewrittenHarness);
    const entryFile = path.join(repo, sourceFiles[0]);
    const entry = rewriteFixtureImports(readFileSync(entryFile, 'utf8'), entryFile).replaceAll(
      path.join(repo, 'tests/support/catalog-manager-performance-harness'),
      path.join(generated, 'harness.tsx')
    );
    writeFileSync(path.join(generated, 'entry.tsx'), entry);
    writeFileSync(
      path.join(generated, 'index.html'),
      '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A26 synthetic readonly fixture</title></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>'
    );
    await build({
      configFile: path.join(repo, 'apps/web/vite.config.ts'),
      root: generated,
      mode: 'beta',
      plugins: [
        {
          name: 'a26-common-current-dependencies',
          enforce: 'pre',
          async resolveId(specifier, importer) {
            if (
              importer?.startsWith(generated + path.sep) &&
              !specifier.startsWith('.') &&
              !path.isAbsolute(specifier) &&
              !specifier.startsWith('\0')
            )
              return this.resolve(specifier, path.join(repo, 'apps/web/src/main.tsx'), {
                skipSelf: true
              });
            return null;
          }
        }
      ],
      envDir: false,
      envPrefix: 'A26_NEVER_FROM_PROCESS_',
      publicDir: path.join(repo, 'apps/web/public'),
      base: './',
      define: Object.fromEntries(
        Object.entries(flags).map(([key, value]) => [
          `import.meta.env.${key}`,
          JSON.stringify(value)
        ])
      ),
      build: {
        outDir: dist,
        emptyOutDir: false,
        manifest: true,
        sourcemap: false,
        rollupOptions: { input: path.join(generated, 'index.html') }
      }
    });
    /** @type {Record<string,string>} */ const digests = {};
    const walk = dir => {
      for (const file of readdirSync(dir)) {
        const full = path.join(dir, file);
        if (statSync(full).isDirectory()) walk(full);
        else digests[path.relative(dist, full)] = hash(readFileSync(full));
      }
    };
    walk(dist);
    report.phases.push({
      phase,
      dialogGeneratedDigest: hash(readFileSync(frozenDialog)),
      bundleDigests: digests,
      cssContentDigests: Object.entries(digests)
        .filter(([file]) => file.endsWith('.css'))
        .map(([, digest]) => digest)
        .sort(),
      runs: []
    });
    save();
  }
  if (
    JSON.stringify(report.phases[0].cssContentDigests) !==
    JSON.stringify(report.phases[1].cssContentDigests)
  )
    throw Error(
      'Baseline/after compiled CSS differs; retain artifacts and reconcile before measuring'
    );
  browser = await chromium.launch({
    executablePath: executable,
    headless: options.headless === true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run'
    ]
  });
  const activeBrowser = browser;
  report.environment.browserVersion = activeBrowser.version();
  save();
  for (const phase of report.phases) {
    const dist = path.join(output, phase.phase, 'dist');
    const server = createServer((request, response) => {
      let target;
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        target = path.resolve(
          dist,
          '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
        );
        if (!target.startsWith(dist + path.sep)) throw Error();
        const bytes = readFileSync(target);
        const ext = path.extname(target);
        response.setHeader(
          'content-type',
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.woff2': 'font/woff2',
            '.woff': 'font/woff'
          }[ext] ?? 'application/octet-stream'
        );
        response.end(bytes);
      } catch {
        response.statusCode = 404;
        response.end('Not found');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No loopback address');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      for (const size of [0, 60, 500, 2000]) {
        /** @type {Record<string, any>} */ const run = {
          size,
          status: 'running',
          cold: [],
          actions: { search: [], selection: [], details_open: [], details_close: [] },
          network: [],
          errors: [],
          traces: []
        };
        phase.runs.push(run);
        save();
        const runDir = path.join(output, phase.phase, String(size));
        mkdirSync(runDir, { recursive: true });
        async function open(label) {
          const context = await activeBrowser.newContext({
            viewport: { width: 1440, height: 900 },
            deviceScaleFactor: 1,
            locale: 'en-GB',
            timezoneId: 'Europe/Kyiv',
            reducedMotion: 'no-preference'
          });
          await context.route('**/*', async route => {
            const url = route.request().url();
            if (url.startsWith(origin + '/')) {
              run.network.push({ label, url, method: route.request().method(), blocked: false });
              await route.continue();
            } else {
              run.network.push({ label, url, method: route.request().method(), blocked: true });
              await route.abort('blockedbyclient');
            }
          });
          const page = await context.newPage();
          page.on('pageerror', error => run.errors.push({ label, error: error.message }));
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1
          });
          await cdp.send('Tracing.start', {
            categories:
              'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame,cc,benchmark',
            transferMode: 'ReturnAsStream'
          });
          await page.goto(`${origin}/?size=${size}&sample=${encodeURIComponent(label)}`, {
            waitUntil: 'load',
            timeout: 60000
          });
          await page.waitForFunction('window.__a26?.ready()', {}, { timeout: 60000 });
          await page.evaluate('document.fonts.ready.then(()=>true)');
          const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
          let tracingStopped = false;
          /** @type {any[]} */ let capturedEvents = [];
          async function finishTrace() {
            if (tracingStopped) return capturedEvents;
            tracingStopped = true;
            /** @type {Promise<any>} */ const done = new Promise(resolve =>
              cdp.once('Tracing.tracingComplete', resolve)
            );
            await cdp.send('Tracing.end');
            const event = await done;
            if (!event.stream) throw Error('Trace stream missing');
            /** @type {Buffer[]} */ const chunks = [];
            while (true) {
              const part = await cdp.send('IO.read', { handle: event.stream });
              chunks.push(
                part.base64Encoded ? Buffer.from(part.data, 'base64') : Buffer.from(part.data)
              );
              if (part.eof) break;
            }
            await cdp.send('IO.close', { handle: event.stream });
            const bytes = Buffer.concat(chunks);
            if (bytes.length > 512 * 1024 * 1024)
              throw Error('Trace exceeded bounded parse budget');
            const file = path.join(runDir, label + '.trace.json');
            writeFileSync(file, bytes);
            run.traces.push(path.relative(output, file));
            capturedEvents = JSON.parse(bytes.toString()).traceEvents;
            return capturedEvents;
          }
          return { context, page, frame, finishTrace };
        }
        for (let index = 0; index < 10; index++) {
          const label = `cold-${index}`,
            session = await open(label);
          try {
            const sample = await evaluate(session.page, `window.__a26.finish('cold',${size})`);
            const screenshot = path.join(runDir, label + '.png');
            await session.page.screenshot({ path: screenshot });
            await evaluate(
              session.page,
              `performance.mark(${JSON.stringify(`a26:${label}:screenshot`)})`
            );
            const nav = await evaluate(
              session.page,
              'performance.getEntriesByType("navigation")[0]?.toJSON()'
            );
            const events = await session.finishTrace();
            run.cold.push(
              ...verifyPaintSamples(
                events,
                [{ ...sample, screenshot: path.relative(output, screenshot), navigation: nav }],
                session.frame
              )
            );
            save();
          } finally {
            await session
              .finishTrace()
              .catch(error => run.errors.push({ label, error: String(error) }));
            save();
            await session.context.close();
          }
        }
        const coldValid = run.cold.filter(sample => sample.verified);
        run.coldSummary = {
          samples: run.cold.length,
          verified: coldValid.length,
          entryToDrawP50Ms:
            coldValid.length === 10
              ? percentile(
                  coldValid.map(sample => sample.latencyMs),
                  50
                )
              : null,
          entryToDrawP95Ms:
            coldValid.length === 10
              ? percentile(
                  coldValid.map(sample => sample.latencyMs),
                  95
                )
              : null,
          navigationToDrawP50Ms:
            coldValid.length === 10
              ? percentile(
                  coldValid.map(sample => sample.start + sample.latencyMs),
                  50
                )
              : null,
          navigationToDrawP95Ms:
            coldValid.length === 10
              ? percentile(
                  coldValid.map(sample => sample.start + sample.latencyMs),
                  95
                )
              : null,
          scope:
            'entry mark before createRoot, plus navigation-relative composite; transport/navigation raw timing retained'
        };
        const session = await open('actions');
        try {
          const fixture = await evaluate(session.page, 'window.__a26.fixture');
          async function sample(action, expected, index, warmup) {
            const id = `${action}-${warmup ? 'warmup' : 'sample'}-${index}`;
            if (action === 'details_open') {
              await session.page
                .locator(`tr[data-catalog-id="${fixture.targetId}"] .catalog-identity`)
                .click();
              await session.page.getByRole('button', { name: 'Configure', exact: true }).waitFor();
            }
            const beforeCounts = await evaluate(session.page, 'window.__a26.metrics()');
            await evaluate(
              session.page,
              `window.__a26.arm(${JSON.stringify(id)},${JSON.stringify(action.startsWith('details_') ? 'details' : action)},${JSON.stringify(expected)})`
            );
            if (action === 'search')
              await session.page
                .getByRole('searchbox')
                .fill(
                  size === 0
                    ? index % 2
                      ? ''
                      : 'неточний-запит-без-збігів'
                    : index % 2
                      ? ''
                      : 'льон'
                );
            else if (action === 'selection')
              await session.page.locator('.team-updater-select-all .ui-checkbox-content').click();
            else if (action === 'details_open')
              await session.page.getByRole('button', { name: 'Configure', exact: true }).click();
            else
              await session.page
                .locator('.team-updater-detail')
                .getByRole('button', { name: 'Close', exact: true })
                .click();
            const canonical = action.startsWith('details_') ? 'details' : action;
            const raw = await evaluate(
              session.page,
              `window.__a26.finish(${JSON.stringify(canonical)},${JSON.stringify(expected)})`
            );
            if (warmup) return;
            const screenshot = path.join(runDir, id + '.png');
            await session.page.screenshot({ path: screenshot });
            await evaluate(
              session.page,
              `performance.mark(${JSON.stringify(`a26:${id}:screenshot`)})`
            );
            if (
              !(await evaluate(
                session.page,
                `window.__a26.matches(${JSON.stringify(canonical)},${JSON.stringify(expected)})`
              ))
            )
              throw Error('DOM changed around screenshot');
            run.actions[action].push({
              ...raw,
              beforeCounts,
              screenshot: path.relative(output, screenshot)
            });
          }
          for (const warmup of [true, false])
            for (let index = 0; index < (warmup ? 10 : 50); index++)
              await sample('search', size === 0 ? 0 : index % 2 ? size : size / 2, index, warmup);
          // Restore full search before selecting/opening details. Empty fixture has
          // disabled selection and no target: record N/A instead of fake samples.
          await session.page.getByRole('searchbox').fill('');
          await session.page.waitForFunction('window.__a26.ready()');
          if (size) {
            for (const warmup of [true, false])
              for (let index = 0; index < (warmup ? 10 : 50); index++)
                await sample('selection', index % 2 === 0, index, warmup);
            for (const warmup of [true, false])
              for (let index = 0; index < (warmup ? 10 : 50); index++) {
                await sample('details_open', true, index, warmup);
                await sample('details_close', false, index, warmup);
              }
          } else run.notApplicable = ['selection: empty fixture', 'details: no catalog identity'];
          const events = await session.finishTrace();
          for (const action of Object.keys(run.actions)) {
            run.actions[action] = verifyPaintSamples(events, run.actions[action], session.frame);
            const valid = run.actions[action].filter(s => s.verified).map(s => s.latencyMs);
            const p95 = percentile(valid, 95);
            const raw = run.actions[action];
            run[action + 'Summary'] = {
              status:
                run.actions[action].length === 0
                  ? 'not_applicable'
                  : valid.length === run.actions[action].length
                    ? 'measured'
                    : 'incomplete_trace_proof',
              samples: run.actions[action].length,
              verified: valid.length,
              p50Ms: valid.length === 50 ? percentile(valid, 50) : null,
              p95Ms: valid.length === 50 ? p95 : null,
              targetAt500Passed:
                size === 500 && valid.length === 50 && typeof p95 === 'number' ? p95 <= 200 : null,
              maximumDomRows: raw.length
                ? Math.max(...raw.map(sample => sample.metrics.domRows))
                : null,
              injectedReadCallsDelta: raw.reduce(
                (sum, sample) =>
                  sum +
                  ['managerReads', 'catalogReads', 'profileReads', 'stateReads'].reduce(
                    (delta, key) => delta + sample.metrics[key] - sample.beforeCounts[key],
                    0
                  ),
                0
              ),
              reactCommitsDelta: raw.every(
                sample =>
                  typeof sample.metrics.commits === 'number' &&
                  typeof sample.beforeCounts.commits === 'number'
              )
                ? raw.reduce(
                    (sum, sample) => sum + sample.metrics.commits - sample.beforeCounts.commits,
                    0
                  )
                : null
            };
          }
          run.finalCounts = await evaluate(session.page, 'window.__a26.metrics()');
          if (run.finalCounts.writes !== 0) throw Error('Fixture write attempted');
          run.status = run.network.some(request => request.blocked)
            ? 'unexpected_network'
            : run.errors.length
              ? 'page_errors'
              : coldValid.length !== 10
                ? 'incomplete_cold_trace_proof'
                : Object.values(run.actions)
                      .flat()
                      .every(value => Boolean(/** @type {any} */ (value).verified))
                  ? 'measured'
                  : 'incomplete_trace_proof';
          save();
        } finally {
          await session
            .finishTrace()
            .catch(error => run.errors.push({ label: 'actions', error: String(error) }));
          save();
          await session.context.close();
        }
      }
    } finally {
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve(undefined)))
      );
    }
  }
  report.status = report.phases.every(p => p.runs.every(r => r.status === 'measured'))
    ? 'measured'
    : 'incomplete';
  const targets = report.phases.flatMap(p =>
    p.runs
      .filter(r => r.size === 500)
      .flatMap(r =>
        ['search', 'selection', 'details_open', 'details_close'].map(
          action => r[action + 'Summary']?.targetAt500Passed
        )
      )
  );
  report.latencyAt500 =
    targets.length === 8 && targets.every(value => value === true)
      ? 'passed'
      : targets.some(value => value === false)
        ? 'failed'
        : 'unknown';
  report.T053Complete = false;
  report.remainingAcceptance = [
    'second OS functional/stress parity',
    'scope-limited baseline interpretation and trace/screenshot review',
    'actual app power/AC evidence'
  ];
  if (report.status !== 'measured' || report.latencyAt500 !== 'passed') process.exitCode = 1;
  save();
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  save();
  process.exitCode = 1;
} finally {
  await browser?.close();
}
process.stdout.write(`A26 ${report.status}: ${path.join(output, 'report.json')}\n`);
