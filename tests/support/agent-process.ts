import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSupportRoot } from '../../apps/agent/src/platform/platform.js';
import { handlesUnder, isAlive, survivorsOf, describeSurvivors } from './machine-probe.js';
import { waitFor } from './wait.js';
import { writeStubTool } from './stub-tools/index.js';

/**
 * Boots a real, out-of-process local app for a test to drive.
 *
 * The end-to-end script has done this since it was written, and three things about how it
 * did it are why this exists as a module instead:
 *
 * - **It wrote into the developer's real data directory (A13).** It redirected four state
 *   paths and left five behind, so any scenario that touched transcription polluted the
 *   actual Application Support folder — a test that can corrupt the machine it runs on.
 * - **Its port allocation was racy by construction (A15).** Bind zero, close, reuse the
 *   number: correct only if nothing else claims it in the gap.
 * - **It set an environment variable nothing reads (A16).** `NO_OPEN` has no consumer under
 *   `apps/`, and a no-op in a harness reads as a guarantee that is not there.
 *
 * All three are fixed here, and the isolation is belt-and-braces on purpose: the nine paths
 * are redirected individually so a test can look at what was written, **and**
 * `AGENT_SUPPORT_DIRECTORY_NAME` is pointed somewhere unique so a tenth path added next
 * month is contained by default rather than by someone remembering this file.
 */

/** What `spawn` returns for `['ignore', 'pipe', 'pipe']`: no stdin, both outputs readable. */
type AgentChild = ChildProcessByStdio<null, Readable, Readable>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Where every piece of the agent's durable state was sent. */
export interface AgentStatePaths {
  /** Root of the isolated tree. Removed on stop. */
  root: string;
  outputFolder: string;
  /** The nine A13 names, in the order they appear in that finding. */
  state: string;
  cache: string;
  imports: string;
  images: string;
  transcribeImports: string;
  transcribeDocuments: string;
  translationCache: string;
  transcribePreviews: string;
  transcriptionState: string;
  /** Not part of the nine, but equally real state. */
  power: string;
  sessionToken: string;
  landingWorkspace: string;
  /**
   * The support-root backstop. Everything defaults to a name under here, so pointing it
   * somewhere unique contains a path nobody remembered to redirect — but it is created
   * inside the user's real Application Support folder, so the harness must remove it again
   * or every run leaves a directory behind.
   */
  supportRoot: string;
  supportDirectoryName: string;
}

export interface BootOptions {
  /** Node binary to run the agent with. Defaults to the one running the test. */
  nodeBinary?: string;
  /** Built agent entry point. Defaults to `apps/agent/dist/index.js`. */
  entry?: string;
  /**
   * Extra environment for the child — how a test points `FFMPEG_PATH` at a stub from
   * `tests/support/stub-tools/`. Merged last, so it can override anything below.
   */
  env?: Record<string, string>;
  /** How long to wait for the first successful health response. */
  readyTimeoutMs?: number;
  /** Initial compressor settings, written to the state file before boot. */
  settings?: Record<string, unknown>;
  /**
   * Which tools the booted agent should find on its PATH.
   *
   * `lifecycle` — the default — points the media tools at the stubs in
   * `tests/support/stub-tools/`, because a suite about starting, stopping and
   * restarting work does not need a real encoder to prove anything, and a real
   * encoder makes it slow and machine-dependent.
   *
   * `real-media` leaves the environment alone so the agent finds the real
   * binaries. That is the only difference between the two harnesses, which is
   * the point: one boot path, one place where a change to it can be wrong.
   */
  profile?: 'lifecycle' | 'real-media';
}

export interface AgentProcess {
  readonly origin: string;
  readonly port: number;
  /** The paired session token, taken from the pairing redirect exactly as a browser would. */
  readonly token: string;
  readonly pid: number;
  readonly paths: AgentStatePaths;
  /** Authenticated JSON call. Throws with the agent's own error code on a failure status. */
  api<T = unknown>(route: string, init?: RequestInit): Promise<T>;
  /** Authenticated raw call, for streams, ranges and deliberate failures. */
  request(route: string, init?: RequestInit): Promise<Response>;
  /** Everything the child wrote to stdout and stderr, most recent 20 KB. */
  log(): string;
  /** Terminate as a user's quit would, then prove nothing survived it. */
  stop(): Promise<void>;
  /** Kill without warning, for restart-recovery cases. State is kept. */
  crash(): Promise<void>;
  /** Boot again over the same state, as a relaunch after a crash would. */
  restart(): Promise<void>;
}

/**
 * A port nothing else is listening on.
 *
 * Discovery is inherently racy — the operating system will not hold a port for a process
 * that does not exist yet. So the race is absorbed rather than denied: a bind failure in
 * the child costs a retry with a fresh number, never a flake.
 */
async function discoverPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function createStateTree(settings?: Record<string, unknown>): Promise<AgentStatePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soty-agent-'));
  const at = (name: string) => path.join(root, name);
  const supportDirectoryName = `SotyTest-${randomBytes(6).toString('hex')}`;
  const paths: AgentStatePaths = {
    root,
    outputFolder: at('output'),
    state: at('state.json'),
    cache: at('estimate-cache.json'),
    imports: at('imports'),
    images: at('images'),
    transcribeImports: at('transcribe-imports'),
    transcribeDocuments: at('transcribe-documents'),
    translationCache: at('translation-cache'),
    transcribePreviews: at('transcribe-previews'),
    transcriptionState: at('transcription-state.json'),
    power: at('power.json'),
    sessionToken: at('session-token.json'),
    landingWorkspace: at('landing-workspaces'),
    supportDirectoryName,
    supportRoot: path.join(appSupportRoot(), supportDirectoryName)
  };

  await mkdir(paths.outputFolder, { recursive: true });
  await writeFile(
    paths.state,
    JSON.stringify({
      settings: {
        mode: 'optimal',
        outputMode: 'chosen-folder',
        outputFolder: paths.outputFolder,
        frameRate: null,
        resolutionLimit: null,
        rateControl: 'crf',
        crf: 26,
        videoBitrateKbps: 2500,
        imageEmbedding: {
          enabled: false,
          startImage: null,
          endImage: null,
          finalDurationMode: 'random-40-50',
          customFinalDurationSeconds: 2700,
          fitMode: 'cover'
        },
        ...settings
      },
      jobs: [],
      batch: null
    }),
    'utf8'
  );
  return paths;
}

function environmentFor(paths: AgentStatePaths, port: number, extra?: Record<string, string>) {
  return {
    ...process.env,
    AGENT_PORT: String(port),

    // The nine of A13. Enumerated rather than left to the support-directory override below,
    // so a test can read back exactly what the agent persisted and where.
    AGENT_STATE_PATH: paths.state,
    AGENT_CACHE_PATH: paths.cache,
    AGENT_IMPORT_PATH: paths.imports,
    AGENT_IMAGE_PATH: paths.images,
    AGENT_TRANSCRIBE_IMPORT_PATH: paths.transcribeImports,
    AGENT_TRANSCRIBE_DOCUMENTS_PATH: paths.transcribeDocuments,
    AGENT_TRANSLATION_CACHE_PATH: paths.translationCache,
    AGENT_TRANSCRIBE_PREVIEWS_PATH: paths.transcribePreviews,
    AGENT_TRANSCRIPTION_STATE_PATH: paths.transcriptionState,

    // Equally real state, and equally destructive to write into the developer's own copy.
    AGENT_POWER_STATE_PATH: paths.power,
    AGENT_SESSION_TOKEN_PATH: paths.sessionToken,
    AGENT_LANDING_WORKSPACE: paths.landingWorkspace,

    // The backstop. Every path above defaults to a name under the support root, so pointing
    // the root itself at a directory nothing else uses means a path added later is isolated
    // whether or not anyone remembers to add it here. A single segment, because
    // `files/support-dir.ts` accepts nothing else — and removed on stop, because it is
    // created inside the user's own Application Support folder.
    AGENT_SUPPORT_DIRECTORY_NAME: paths.supportDirectoryName,

    NODE_ENV: 'test',
    ...extra
  };
}

/**
 * The tool environment for a profile.
 *
 * Kept here rather than in each suite so "which tools does this run use" has one
 * answer, and so the real-media harness differs from the lifecycle one by a
 * single named switch instead of by a divergent copy of the boot sequence.
 */
async function environmentForProfile(
  profile: 'lifecycle' | 'real-media'
): Promise<Record<string, string>> {
  if (profile === 'real-media') return {};
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wishly-stub-tools-'));
  const ffmpeg = await writeStubTool(directory, 'ffmpeg', { writeOutput: true });
  const ffprobe = await writeStubTool(directory, 'ffprobe', { writeOutput: true });
  return { FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe };
}

export async function bootAgent(options: BootOptions = {}): Promise<AgentProcess> {
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const entry = options.entry ?? path.join(ROOT, 'apps/agent/dist/index.js');
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const paths = await createStateTree(options.settings);
  // The profile only ever adds environment, and always *before* the caller's
  // own `env`, so a test that wants one stub in an otherwise real run can still
  // say so and be obeyed.
  const profileEnv = await environmentForProfile(options.profile ?? 'lifecycle');
  const env = { ...profileEnv, ...options.env };

  let child: AgentChild | null = null;
  let log = '';
  let port = 0;
  let origin = '';
  let token = '';

  const collect = (chunk: unknown) => {
    log = (log + String(chunk)).slice(-20_000);
  };

  const launch = async (): Promise<boolean> => {
    port = await discoverPort();
    origin = `http://127.0.0.1:${port}`;
    const started = spawn(nodeBinary, [entry], {
      cwd: ROOT,
      env: environmentFor(paths, port, env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    started.stdout.on('data', collect);
    started.stderr.on('data', collect);

    // Raced against the health poll rather than checked inside it: `waitFor` treats a
    // throwing condition as "not settled yet" and keeps polling, so a child that died on
    // its first line would otherwise cost the full ready timeout before saying so.
    const died = new Promise<never>((_, reject) => {
      started.once('close', (code, signal) =>
        reject(new Error(`agent exited during boot (code ${code}, signal ${signal})`))
      );
    });
    // The loser of the race settles later with nobody listening; without this that is an
    // unhandled rejection that fails an unrelated test.
    died.catch(() => {});

    try {
      await Promise.race([
        waitFor(async () => (await fetch(`${origin}/health`, { cache: 'no-store' })).ok, {
          timeoutMs: readyTimeoutMs,
          describe: `agent to answer /health on ${origin}`
        }),
        died
      ]);
    } catch (error) {
      started.kill('SIGKILL');
      // The one failure worth retrying rather than reporting: something claimed the port
      // between discovering it and the child binding it.
      if (/EADDRINUSE|address already in use/i.test(log)) return false;
      throw new Error(`${(error as Error).message}\n--- agent log ---\n${log}`, {
        cause: error
      });
    }

    child = started;
    return true;
  };

  // Three attempts. A fourth would not distinguish a busy machine from a real bug, and a
  // harness that retries forever turns a broken agent into a timeout with no explanation.
  let booted = false;
  for (let attempt = 0; attempt < 3 && !booted; attempt += 1) booted = await launch();
  if (!booted || !child) {
    await rm(paths.root, { recursive: true, force: true });
    await rm(paths.supportRoot, { recursive: true, force: true });
    throw new Error(`agent could not bind a port in three attempts\n--- agent log ---\n${log}`);
  }

  token = await pair(origin);

  const request = (route: string, init: RequestInit = {}) =>
    fetch(`${origin}${route}`, {
      ...init,
      headers: { 'x-session-token': token, ...(init.headers ?? {}) }
    });

  const api = async <T>(route: string, init: RequestInit = {}): Promise<T> => {
    const response = await request(route, init);
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(`${route}: ${body.error ?? response.status}`);
    return body;
  };

  const running = () => child as AgentChild;

  /** SIGTERM, then SIGKILL on a deadline, then prove the tree is actually gone. */
  const terminate = async (verify: boolean) => {
    const process_ = running();
    if (!isAlive(process_.pid ?? -1)) return;
    // Captured before the signal: after it, the tree is unreadable and a leaked
    // grandchild would have no identity to check against.
    const handles = await handlesUnder(process_.pid as number);
    const closed = new Promise<void>(resolve => process_.once('close', () => resolve()));
    process_.kill('SIGTERM');
    const escalation = setTimeout(() => process_.kill('SIGKILL'), 5_000);
    await closed;
    clearTimeout(escalation);

    if (!verify) return;
    const survivors = await survivorsOf(handles);
    if (survivors.length > 0)
      throw new Error(`agent stop left processes behind — ${describeSurvivors(survivors)}`);
  };

  return {
    get origin() {
      return origin;
    },
    get port() {
      return port;
    },
    get token() {
      return token;
    },
    get pid() {
      return running().pid as number;
    },
    paths,
    api,
    request,
    log: () => log,
    async stop() {
      await terminate(true);
      await rm(paths.root, { recursive: true, force: true });
      await rm(paths.supportRoot, { recursive: true, force: true });
    },
    async crash() {
      // No SIGTERM: the point of these cases is what the next boot finds after a
      // termination the agent never got to handle.
      const process_ = running();
      const closed = new Promise<void>(resolve => process_.once('close', () => resolve()));
      process_.kill('SIGKILL');
      await closed;
    },
    async restart() {
      if (isAlive(running().pid ?? -1)) await terminate(false);
      log = '';
      let restarted = false;
      for (let attempt = 0; attempt < 3 && !restarted; attempt += 1) restarted = await launch();
      if (!restarted) throw new Error(`agent could not rebind on restart\n${log}`);
      token = await pair(origin);
    }
  };
}

/**
 * Takes the session token the way a browser does — from the pairing redirect's fragment.
 *
 * Reading it out of the token file instead would be simpler and would test nothing: the
 * pairing handshake is itself part of what has to keep working.
 */
async function pair(origin: string): Promise<string> {
  const response = await fetch(`${origin}/local`, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (!location) throw new Error('agent pairing redirect is missing a location');
  const token = new URL(location, origin).hash.replace('#agentToken=', '');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`agent pairing token is malformed: ${token}`);
  return token;
}
