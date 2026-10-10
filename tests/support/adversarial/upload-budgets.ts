import { access, mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import type { LandingEvent } from '../../../packages/shared/src/types.js';
import { LandingOptimizer } from '../../../apps/agent/src/landing/optimizer.js';
import { registerLandingRoutes } from '../../../apps/agent/src/landing/routes.js';
import { EventChannel } from '../../../apps/agent/src/server/sse.js';
import type { ToolModule } from '../../../apps/agent/src/server/tools.js';
import {
  DEFAULT_UPLOAD_BYTES,
  FOLDER_UPLOAD_LIMITS,
  type FolderUploadLimits
} from '../../../apps/agent/src/server/upload-limits.js';
import { multipartBody, outcome, type AdversarialSuite } from '../adversarial.js';
import { startMinimalAgent, type MinimalAgent } from '../minimal-agent.js';
import { removeTemporaryDirectory } from '../temp-dir.js';

/**
 * C8. Oversized and malformed uploads against the real server, with the real multipart
 * plugin and the real landing routes.
 *
 * The session budget is narrowed for the count and byte attempts — five thousand files or two
 * gigabytes would make the suite the slowest thing in CI for no extra proof — while depth and
 * segment length keep the contract's own values, because those are cheap to exceed honestly.
 */

export const NARROW_LIMITS: Readonly<FolderUploadLimits> = Object.freeze({
  ...FOLDER_UPLOAD_LIMITS,
  maxFiles: 3,
  maxBytes: 1_000,
  maxDurationMs: 60_000
});

/** A route that states no limit of its own: what the multipart default does to it. */
export const UNSTATED_LIMIT_ROUTE = '/api/test/unstated-limit';

export interface UploadTarget {
  agent: MinimalAgent;
  optimizer: LandingOptimizer;
  /** The budget's clock; advance it to spend the wall-clock budget. */
  clock: { now: number };
  /** Root every landing workspace is created under, so a teardown can be checked. */
  workspaceRoot: string;
  post(
    url: string,
    body?: { payload: Buffer; headers: Record<string, string> } | object
  ): Promise<{
    statusCode: number;
    error: string | null;
    json: Record<string, unknown> | null;
  }>;
  begin(): Promise<string>;
  sendFile(relPath: string, content: Buffer | string): ReturnType<UploadTarget['post']>;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false
  );
}

async function startUploadTarget(): Promise<UploadTarget & { stop(): Promise<void> }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'soty-upload-budgets-'));
  const previousRoot = process.env.AGENT_LANDING_WORKSPACE;
  process.env.AGENT_LANDING_WORKSPACE = workspaceRoot;

  const clock = { now: 1_000_000 };
  const tools = { ffmpeg: false, ffprobe: false };
  const optimizer = new LandingOptimizer(tools, () => undefined);
  const events = new EventChannel<LandingEvent>(new Set(), () => ({
    type: 'landing:state',
    state: optimizer.state()
  }));
  const landing: ToolModule = {
    id: 'landing',
    lifecycle: null,
    register: (app, ctx) => {
      registerLandingRoutes(app, {
        optimizer,
        events,
        acceptingNewTasks: ctx.acceptingNewTasks,
        folderUploadLimits: NARROW_LIMITS,
        clock: () => clock.now
      });
      // Deliberately states no limit: whatever it accepts is the plugin default.
      app.post(UNSTATED_LIMIT_ROUTE, async request => {
        const part = await request.file();
        if (!part) return { files: 0 };
        let received = 0;
        let failed: string | null = null;
        await pipeline(
          part.file,
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              received += chunk.length;
              callback();
            }
          })
        ).catch((error: { code?: string }) => {
          failed = error.code ?? 'STREAM_FAILED';
        });
        return { received, truncated: part.file.truncated, failed };
      });
    },
    busy: () => false,
    cancel: async () => false,
    cancelAll: async () => 0,
    shutdown: async () => undefined
  };
  const agent = await startMinimalAgent({ modules: [landing] });

  const post: UploadTarget['post'] = async (url, body) => {
    const multipart = body && 'payload' in body && Buffer.isBuffer(body.payload);
    const response = await agent.app.inject({
      method: 'POST',
      url,
      headers: {
        'x-session-token': agent.token,
        ...(multipart ? (body as { headers: Record<string, string> }).headers : {})
      },
      ...(multipart
        ? { payload: (body as { payload: Buffer }).payload }
        : body
          ? { payload: body as object }
          : {})
    });
    let json: Record<string, unknown> | null;
    try {
      json = response.json();
    } catch {
      json = null;
    }
    return {
      statusCode: response.statusCode,
      error: typeof json?.error === 'string' ? json.error : null,
      json
    };
  };

  return {
    agent,
    optimizer,
    clock,
    workspaceRoot,
    post,
    async begin() {
      const response = await post('/api/landing/upload/folder/begin', { name: 'landing' });
      if (response.statusCode !== 200) throw new Error(`begin answered ${response.statusCode}`);
      return optimizer.currentInputDir();
    },
    sendFile(relPath, content) {
      return post(
        '/api/landing/upload/folder/file',
        multipartBody([
          { kind: 'field', name: 'relPath', value: relPath },
          { kind: 'file', name: 'file', filename: 'asset.bin', content }
        ])
      );
    },
    async stop() {
      await agent.stop();
      await optimizer.shutdown().catch(() => undefined);
      if (previousRoot === undefined) delete process.env.AGENT_LANDING_WORKSPACE;
      else process.env.AGENT_LANDING_WORKSPACE = previousRoot;
      await removeTemporaryDirectory(workspaceRoot);
    }
  };
}

/** Refused with the budget code, and the session's directory is gone. */
async function budgetRefusal(
  target: UploadTarget,
  inputDir: string,
  response: Awaited<ReturnType<UploadTarget['post']>>
) {
  const tornDown = !(await exists(inputDir));
  return outcome(
    response.statusCode === 413 && response.error === 'UPLOAD_BUDGET_EXCEEDED' && tornDown,
    `${response.statusCode} ${response.error ?? '-'}; session directory ${tornDown ? 'removed' : 'still present'}`
  );
}

/** Nothing landed outside the session's own directory. */
async function nothingEscaped(target: UploadTarget, inputDir: string) {
  const entries = await readdir(target.workspaceRoot, { recursive: true });
  const workspace = path.relative(target.workspaceRoot, path.dirname(inputDir));
  return entries.every(entry => entry === workspace || entry.startsWith(`${workspace}${path.sep}`));
}

export const uploadBudgetSuite: AdversarialSuite<UploadTarget> = {
  testFile: 'tests/upload-budgets.test.ts',
  start: startUploadTarget,
  attempts: [
    {
      name: 'one file more than the session allows',
      async attempt(target) {
        const inputDir = await target.begin();
        for (let index = 0; index < NARROW_LIMITS.maxFiles; index += 1) {
          const accepted = await target.sendFile(`asset-${index}.txt`, 'x');
          if (accepted.statusCode !== 200) {
            return outcome(false, `a file within budget was refused: ${accepted.statusCode}`);
          }
        }
        return budgetRefusal(target, inputDir, await target.sendFile('one-too-many.txt', 'x'));
      }
    },
    {
      name: 'more bytes in total than the session allows, each file small',
      async attempt(target) {
        const inputDir = await target.begin();
        const first = await target.sendFile('first.bin', Buffer.alloc(600, 1));
        if (first.statusCode !== 200)
          return outcome(false, `first file refused: ${first.statusCode}`);
        return budgetRefusal(
          target,
          inputDir,
          await target.sendFile('second.bin', Buffer.alloc(600, 2))
        );
      }
    },
    {
      name: 'a file sent after the wall-clock budget ran out',
      async attempt(target) {
        const inputDir = await target.begin();
        target.clock.now += NARROW_LIMITS.maxDurationMs + 1;
        return budgetRefusal(target, inputDir, await target.sendFile('late.txt', 'x'));
      }
    },
    {
      name: 'a finish sent after the wall-clock budget ran out',
      async attempt(target) {
        const inputDir = await target.begin();
        await target.sendFile('index.html', '<!doctype html>');
        target.clock.now += NARROW_LIMITS.maxDurationMs + 1;
        return budgetRefusal(
          target,
          inputDir,
          await target.post('/api/landing/upload/folder/finish')
        );
      }
    },
    {
      name: 'a path one segment deeper than the bound',
      async attempt(target) {
        const inputDir = await target.begin();
        const deep = [
          ...Array.from({ length: NARROW_LIMITS.maxDepth }, (_, i) => `d${i}`),
          'f.txt'
        ];
        return budgetRefusal(target, inputDir, await target.sendFile(deep.join('/'), 'x'));
      }
    },
    {
      name: 'a path segment longer than any filesystem accepts',
      async attempt(target) {
        const inputDir = await target.begin();
        const long = `${'a'.repeat(NARROW_LIMITS.maxSegmentLength + 1)}.txt`;
        return budgetRefusal(target, inputDir, await target.sendFile(`dir/${long}`, 'x'));
      }
    },
    {
      name: 'a folder file with no session ever begun',
      async attempt(target) {
        const response = await target.sendFile('orphan.txt', 'x');
        return outcome(
          response.statusCode === 409,
          `${response.statusCode} ${response.error ?? '-'}`
        );
      }
    },
    {
      name: 'a folder file aimed at a ZIP upload, which has no folder budget',
      async attempt(target) {
        await target.optimizer.beginUpload('zip', 'archive.zip');
        const response = await target.sendFile('smuggled.txt', 'x');
        return outcome(
          response.statusCode === 409,
          `${response.statusCode} ${response.error ?? '-'}`
        );
      }
    },
    {
      name: 'a file sent into a session the budget already ended',
      async attempt(target) {
        await target.begin();
        target.clock.now += NARROW_LIMITS.maxDurationMs + 1;
        await target.sendFile('late.txt', 'x');
        const response = await target.sendFile('after.txt', 'x');
        return outcome(
          response.statusCode === 409,
          `${response.statusCode} ${response.error ?? '-'}`
        );
      }
    },
    {
      name: 'a relative path climbing out of the session directory',
      async attempt(target) {
        const inputDir = await target.begin();
        const response = await target.sendFile('../../../escaped.txt', 'x');
        // Neutralised rather than refused: the segments are dropped and the file lands inside.
        const contained = await nothingEscaped(target, inputDir);
        return outcome(contained, `${response.statusCode}; ${contained ? 'contained' : 'escaped'}`);
      }
    },
    {
      name: 'an absolute path as the relative path',
      async attempt(target) {
        const inputDir = await target.begin();
        const absolute = path.join(target.workspaceRoot, 'absolute-escape.txt');
        const response = await target.sendFile(absolute, 'x');
        const contained =
          (await nothingEscaped(target, inputDir)) &&
          !(await exists(path.join(target.workspaceRoot, 'absolute-escape.txt')));
        return outcome(contained, `${response.statusCode}; ${contained ? 'contained' : 'escaped'}`);
      }
    },
    {
      name: 'a path made only of dot segments',
      async attempt(target) {
        await target.begin();
        const response = await target.sendFile('./../.', 'x');
        return outcome(
          response.statusCode === 400,
          `${response.statusCode} ${response.error ?? '-'}`
        );
      }
    },
    {
      name: 'a body over the default ceiling on a route that states no limit',
      async attempt(target) {
        const response = await target.post(
          UNSTATED_LIMIT_ROUTE,
          multipartBody([
            {
              kind: 'file',
              name: 'file',
              filename: 'big.bin',
              content: Buffer.alloc(DEFAULT_UPLOAD_BYTES + 1024)
            }
          ])
        );
        const received = Number(response.json?.received ?? Number.NaN);
        const stopped =
          response.statusCode === 413 ||
          response.json?.truncated === true ||
          response.json?.failed === 'FST_REQ_FILE_TOO_LARGE' ||
          (Number.isFinite(received) && received <= DEFAULT_UPLOAD_BYTES);
        return outcome(
          stopped,
          `${response.statusCode}; received ${response.json?.received ?? '-'}`
        );
      }
    },
    {
      name: 'a second file smuggled into a one-file request',
      async attempt(target) {
        const response = await target.post(
          UNSTATED_LIMIT_ROUTE,
          multipartBody([
            { kind: 'file', name: 'file', filename: 'one.bin', content: 'one' },
            { kind: 'file', name: 'extra', filename: 'two.bin', content: 'two' }
          ])
        );
        // Either the request is refused outright or only the first file was ever read.
        const onlyFirst = response.statusCode === 200 && response.json?.received === 3;
        return outcome(
          response.statusCode === 413 || onlyFirst,
          `${response.statusCode}; received ${response.json?.received ?? '-'}`
        );
      }
    }
  ]
};
