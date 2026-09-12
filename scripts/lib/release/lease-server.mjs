import { createServer } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';

const MAX_MESSAGE_BYTES = 8 * 1024;

/**
 * The kernel's `sun_path` limit. A longer path does not produce a useful error:
 * `listen` appears to succeed, no socket file is created, and the next
 * operation fails with a bare ENOENT that says nothing about why. Checking it
 * here turns a deeply nested run directory into a sentence somebody can act on.
 */
const MAX_SOCKET_PATH_BYTES = process.platform === 'linux' ? 108 : 104;

function deny(code) {
  return { kind: 'denied', code };
}

/**
 * Starts the private, single-worker admission authority.  The capability is
 * deliberately an in-memory value: callers receive it through an inherited
 * descriptor, never an argv value, journal entry, or diagnostic.
 */
export async function startLeaseServer({ socketPath, capability, generation, children = new Map() }) {
  if (!socketPath || !capability || !Number.isInteger(generation)) throw new Error('LEASE_SERVER_CONFIG_INVALID');
  if (Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `LEASE_SOCKET_PATH_TOO_LONG: ${Buffer.byteLength(socketPath)} bytes exceeds the ` +
        `${MAX_SOCKET_PATH_BYTES}-byte limit for ${socketPath}`
    );
  }
  await mkdir(new URL('.', `file://${socketPath}`).pathname, { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  let outer = null;
  let activeChild = null;
  const replies = new Map();
  const expired = new Set();

  const handle = message => {
    if (!message || message.version !== 1 || typeof message.requestId !== 'string') return deny('LEASE_MESSAGE_INVALID');
    if (replies.has(message.requestId)) return replies.get(message.requestId);
    if (message.capability !== capability) return deny('LEASE_CAPABILITY_INVALID');
    if (message.generation !== generation) return deny('LEASE_GENERATION_STALE');
    const registered = children.get(message.childIdentity);
    if (!registered || registered.pid !== message.pid || registered.startedAt !== message.startedAt) return deny('LEASE_CHILD_UNREGISTERED');
    let reply;
    if (message.operation === 'request') {
      if (message.parentLeaseId) {
        if (!outer || outer.id !== message.parentLeaseId) reply = deny('LEASE_PARENT_UNKNOWN');
        else if (activeChild) reply = { kind: 'waiting', reason: 'LEASE_CHILD_ACTIVE', nextCheckAt: Date.now() + 5000 };
        else {
          activeChild = message.childIdentity;
          reply = { kind: 'granted', leaseId: outer.id, substepId: message.stepId, generation };
        }
      } else if (outer) reply = { kind: 'waiting', reason: 'LEASE_BUSY', nextCheckAt: Date.now() + 5000 };
      else {
        outer = { id: `${message.runId}:${generation}`, runId: message.runId, heartbeatAt: Date.now() };
        reply = { kind: 'granted', leaseId: outer.id, substepId: message.stepId, generation };
      }
    } else if (message.operation === 'heartbeat') {
      if (!outer || outer.id !== message.leaseId) reply = deny('LEASE_UNKNOWN');
      else { outer.heartbeatAt = Date.now(); reply = { kind: 'granted', leaseId: outer.id, substepId: message.stepId, generation }; }
    } else if (message.operation === 'release') {
      if (!outer || outer.id !== message.leaseId) reply = expired.has(message.leaseId) ? { kind: 'released', idempotent: true } : deny('LEASE_UNKNOWN');
      else if (activeChild === message.childIdentity) { activeChild = null; reply = { kind: 'released', idempotent: false }; }
      else if (!activeChild) { expired.add(outer.id); outer = null; reply = { kind: 'released', idempotent: false }; }
      else reply = deny('LEASE_CHILD_ACTIVE');
    } else reply = deny('LEASE_OPERATION_INVALID');
    replies.set(message.requestId, reply);
    return reply;
  };

  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return socket.destroy();
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd); buffer = '';
      try { socket.end(`${JSON.stringify(handle(JSON.parse(line)))}\n`); } catch { socket.end(`${JSON.stringify(deny('LEASE_MESSAGE_INVALID'))}\n`); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    async close() { await new Promise(resolve => server.close(resolve)); await rm(socketPath, { force: true }); },
    markHeartbeatLost(leaseId) { if (outer?.id === leaseId && Date.now() - outer.heartbeatAt > 15_000) return { uncertain: true, leaseId }; return { uncertain: false }; }
  };
}
