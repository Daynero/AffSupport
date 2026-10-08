import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path, { isAbsolute } from 'node:path';
import { realpath, stat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';

export async function providerBoundaryDigest() {
  return createHash('sha256').update(await readFile(new URL('./codex-provider.mjs', import.meta.url))).digest('hex');
}

/** Only a single bounded read, never a shell program, approval cache or extra permission. */
export async function allowReadCommand(params, checkout) {
  if (params.kind && params.kind !== 'command') return false;
  if (params.additionalPermissions || params.networkApprovalContext ||
      (params.environmentId != null && params.environmentId !== 'local')) return false;
  if (typeof params.command !== 'string' || params.command.length > 4096) return false;
  // app-server reports the native shell wrapper, not only the inner command.
  // Unwrap this exact non-login form; the inner grammar contains no shell syntax.
  const command = /^\/bin\/(?:zsh|bash|sh) -c '([^']+)'$/.exec(params.command)?.[1] ?? params.command;
  if (!/^(?:\/bin\/cat|cat) [a-zA-Z0-9_./-]+$/.test(command)) return false;
  const cwd = await realpath(params.cwd ?? checkout).catch(() => null);
  const root = await realpath(checkout);
  if (!cwd || (cwd !== root && !cwd.startsWith(`${root}${path.sep}`))) return false;
  const argument = command.slice(command.indexOf(' ') + 1);
  if (argument.startsWith('-')) return false;
  const file = await realpath(path.resolve(cwd, argument)).catch(() => null);
  if (!file || !file.startsWith(`${root}${path.sep}`)) return false;
  const relative = path.relative(root, file);
  if (relative.split(path.sep).some((part) => /^(?:\.git|\.codex|\.agents|\.env.*)$/.test(part)) ||
      /\.(?:env|pem|key)$/.test(relative) || relative.startsWith(`config${path.sep}keys`)) return false;
  const info = await stat(file);
  return info.isFile() && info.size <= 65536;
}

export function validateAutomationPolicy(value) {
  if (!value || value.schemaVersion !== 1 || value.networkEnabled !== false ||
      value.allowPaidFallback !== false || typeof value.providerVersion !== 'string') {
    throw new Error('INVALID_AUTOMATION_POLICY');
  }
  for (const key of ['maxAttemptsPerCause', 'maxAttemptsPerTask', 'maxTokensPerAttempt',
    'maxTokensPerTask', 'maxActiveMsPerAttempt', 'maxActiveMsPerTask',
    'heartbeatMs', 'staleAfterMs', 'panelPort']) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error('INVALID_AUTOMATION_POLICY');
  }
  if (value.panelPort > 65535 || value.staleAfterMs <= value.heartbeatMs ||
      value.maxAttemptsPerCause > value.maxAttemptsPerTask ||
      value.maxTokensPerAttempt > value.maxTokensPerTask) throw new Error('INVALID_AUTOMATION_POLICY');
  return value;
}

/** Trusted argv builder; paths are TOML strings, never interpolated shell commands. */
/** @param {string} checkout @param {string[]} deniedPaths */
export function permissionOverrides(checkout, deniedPaths = []) {
  if (!isAbsolute(checkout) || deniedPaths.some((p) => !isAbsolute(p))) throw new Error('ABSOLUTE_PATH_REQUIRED');
  const entries = {
    ':root': 'deny', ':minimal': 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny',
    [checkout]: 'write',
    [`${checkout}/.git`]: 'deny',
    [`${checkout}/.codex`]: 'deny',
    [`${checkout}/**/*.env`]: 'deny',
    [`${checkout}/**/.env*`]: 'deny',
    [`${checkout}/config/keys`]: 'deny',
  };
  for (const p of deniedPaths) entries[p] = 'deny';
  const filesystem = `{ ${Object.entries(entries).map(([key, access]) => `${JSON.stringify(key)} = ${JSON.stringify(access)}`).join(', ')} }`;
  return [
    '-c', 'default_permissions="soty_repair"',
    '-c', `permissions.soty_repair.filesystem=${filesystem}`,
    '-c', 'permissions.soty_repair.network.enabled=false',
    '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', 'features.plugins=false',
    '-c', 'features.apps=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.shell_tool=true',
    '-c', 'features.unified_exec=true',
    '-c', 'features.code_mode.enabled=false',
    '-c', 'features.shell_snapshot=false',
    '-c', 'allow_login_shell=false',
    '-c', 'web_search="disabled"',
    '-c', 'features.hooks=false',
  ];
}

export function normalizeUsage(value) {
  const keys = ['totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'];
  return Object.fromEntries(keys.map((key) => [key,
    Number.isSafeInteger(value?.total?.[key]) && value.total[key] >= 0 ? value.total[key] : null]));
}

/** Feasibility adapter. No turn is permitted until actual tool restrictions are proved. */
export class CodexProvider extends EventEmitter {
  /** @param {{executable: string, checkout: string, deniedPaths?: string[], timeoutMs?: number, spawnProcess?: typeof spawn, expectedVersion?: string, inspectVersion?: ((executable: string) => Promise<string>) | null, allowRead?: ((params: any) => Promise<boolean>) | null, allowPatch?: ((params: any) => Promise<boolean>) | null}} options */
  constructor({ executable, checkout, deniedPaths = [], timeoutMs = 30000, spawnProcess = spawn, expectedVersion = '0.161.0', inspectVersion = null, allowRead = null, allowPatch = null }) {
    super();
    if (!isAbsolute(executable)) throw new Error('ABSOLUTE_EXECUTABLE_REQUIRED');
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.timeoutMs = timeoutMs;
    this.allowPatch = allowPatch;
    this.allowRead = allowRead;
    this.executable = executable;
    this.expectedVersion = expectedVersion;
    this.inspectVersion = inspectVersion;
    this.decoder = new StringDecoder('utf8');
    this.child = spawnProcess(executable, [
      ...permissionOverrides(checkout, deniedPaths), 'app-server', '--listen', 'stdio://',
    ], { cwd: checkout, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    // Never relay stderr: provider diagnostics can contain local auth/config information.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.fail('PROVIDER_UNAVAILABLE'));
    this.child.on('exit', () => this.fail('PROVIDER_EXITED'));
  }

  fail(code) {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(code));
    }
    this.pending.clear();
    this.emit('unavailable', code);
  }

  consume(chunk) {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > 1048576) {
      this.fail('PROVIDER_OUTPUT_LIMIT');
      this.child.kill('SIGTERM');
      return;
    }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { this.fail('PROVIDER_INVALID_JSON'); return; }
      if (typeof message.method === 'string' && message.id != null) {
        this.emit('serverRequest', { method: message.method });
        if (message.method === 'item/fileChange/requestApproval') {
          Promise.resolve(this.allowPatch?.(message.params) ?? false).then((allowed) => {
            this.send({ id: message.id, result: { decision: allowed ? 'accept' : 'decline' } });
          }).catch(() => this.send({ id: message.id, result: { decision: 'decline' } }));
          continue;
        }
        if (message.method === 'item/commandExecution/requestApproval') {
          Promise.resolve(this.allowRead?.(message.params) ?? false).then((allowed) => {
            this.send({ id: message.id, result: { decision: allowed ? 'accept' : 'decline' } });
          }).catch(() => this.send({ id: message.id, result: { decision: 'decline' } }));
          continue;
        }
        // Fail closed for all provider tool/approval requests, never blanket approve.
        this.send({ id: message.id, error: { code: -32601, message: 'AUTOMATION_APPROVAL_DENIED' } });
      } else if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`PROVIDER_RPC_${message.error.code}`));
        else pending.resolve(message.result);
      } else if (typeof message.method === 'string') {
        this.emit('notification', message);
      }
    }
  }

  send(message) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('PROVIDER_CLOSED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('PROVIDER_RPC_TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async health() {
    const version = this.inspectVersion ? await this.inspectVersion(this.executable) :
      (await promisify(execFile)(this.executable, ['--version'], { timeout: 10000 })).stdout.trim().replace(/^codex-cli\s+/, '');
    if (version !== this.expectedVersion) throw new Error('PROVIDER_VERSION_MISMATCH');
    await this.request('initialize', {
      clientInfo: { name: 'soty_release_feasibility', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    const auth = await this.request('account/read', { refreshToken: false });
    if (auth?.account?.type !== 'chatgpt') throw new Error('MANAGED_CHATGPT_AUTH_REQUIRED');
    return { ready: true, managedAuth: true };
  }

  command(command, cwd) {
    return this.request('command/exec', {
      command, cwd, timeoutMs: 10000, outputBytesCap: 1024,
    });
  }

  interrupt(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  close() {
    this.fail('PROVIDER_CLOSED');
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}
