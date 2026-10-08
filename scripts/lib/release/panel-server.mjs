import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, realpath, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { validTaskId } from './task-store.mjs';
import { redactText } from './redaction.mjs';
import { runDirectory } from './store.mjs';

export async function startPanelServer({ controller, assetsRoot, port = 43150 }) {
  const epoch = randomUUID(); const capabilities = new Map(); const sessions = new Map(); const streams = new Set(); const logRefs = new Map();
  let origin = `http://127.0.0.1:${port}`;
  const safeSnapshot = async (task) => {
    const snapshot = await controller.snapshot(task);
    let ref = [...logRefs].find(([, data]) => data.taskId === task.taskId && data.runId === task.runId)?.[0];
    if (!ref) { ref = randomUUID(); if (logRefs.size >= 1024) logRefs.delete(logRefs.keys().next().value); logRefs.set(ref, { taskId: task.taskId, runId: task.runId }); }
    return { ...snapshot, serverEpoch: epoch, serverObservedAt: new Date().toISOString(), logRef: ref };
  };
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const body = async (req) => {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 2048) throw new Error('REQUEST_TOO_LARGE'); }
    try { return JSON.parse(raw); } catch { throw new Error('INVALID_REQUEST'); }
  };
  const event = (client, name, data) => {
    if (client.res.writableLength > 65536) { client.res.end(); streams.delete(client); return; }
    client.res.write(`id: ${epoch}:${data.taskId}:${data.revision}\nevent: ${name}\ndata: ${JSON.stringify({ ...data, serverEpoch: epoch, serverObservedAt: new Date().toISOString() })}\n\n`);
  };
  const publish = (name) => (data) => {
    const logRef = [...logRefs].find(([, ref]) => ref.taskId === data.taskId && ref.runId === data.runId)?.[0] ?? null;
    for (const client of streams) if (client.taskId === data.taskId) event(client, name, { ...data, logRef });
  };
  const onSnapshot = publish('snapshot'); const onObservation = publish('observation');
  controller.on('snapshot', onSnapshot); controller.on('observation', onObservation);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) { json(res, 403, { error: 'PANEL_ORIGIN_DENIED' }); return; }
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'POST' && url.pathname === '/release-panel/api/session') {
        if (req.headers.origin !== origin) { json(res, 403, { error: 'PANEL_ORIGIN_DENIED' }); return; }
        const input = await body(req); const expiry = capabilities.get(input.capability); capabilities.delete(input.capability);
        if (!expiry || expiry < Date.now()) { json(res, 401, { error: 'PANEL_CAPABILITY_EXPIRED' }); return; }
        const sessionId = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
        sessions.set(sessionId, { csrf, expires: Date.now() + 28800000 });
        res.setHeader('Set-Cookie', `SotyReleasePanel=${sessionId}; HttpOnly; SameSite=Strict; Path=/release-panel/; Max-Age=28800`);
        json(res, 200, { csrf, serverEpoch: epoch }); return;
      }
      if (url.pathname.startsWith('/release-panel/api/')) {
        const sessionId = /(?:^|;\s*)SotyReleasePanel=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
        const session = sessionId ? sessions.get(sessionId) : null;
        if (!session || session.expires < Date.now()) { json(res, 401, { error: 'PANEL_SESSION_REQUIRED' }); return; }
        if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['x-release-csrf'] !== session.csrf)) { json(res, 403, { error: 'PANEL_ORIGIN_DENIED' }); return; }
        const taskMatch = /^\/release-panel\/api\/tasks\/([a-f0-9-]{36})(\/cancel)?$/i.exec(url.pathname);
        if (taskMatch) {
          const id = validTaskId(taskMatch[1]); const task = await controller.store.read(id);
          if (req.method === 'GET' && !taskMatch[2]) { json(res, 200, await safeSnapshot(task)); return; }
          if (req.method === 'POST' && taskMatch[2]) {
            const input = await body(req);
            if (input.confirmation !== 'cancel-release' || !Number.isSafeInteger(input.expectedRevision)) throw new Error('INVALID_REQUEST');
            json(res, 202, await safeSnapshot(await controller.cancel(id, input.expectedRevision))); return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/release-panel/api/tasks') {
          const tasks = await controller.store.list(); json(res, 200, await Promise.all(tasks.slice(-30).map(safeSnapshot))); return;
        }
        if (req.method === 'GET' && url.pathname === '/release-panel/api/events') {
          const id = validTaskId(url.searchParams.get('task'));
          const cursor = req.headers['last-event-id'];
          if (cursor && (String(cursor).length > 120 || !/^[a-f0-9-]+:[a-f0-9-]+:\d+$/i.test(String(cursor)))) throw new Error('INVALID_REQUEST');
          if (streams.size >= 8) { json(res, 503, { error: 'PANEL_STREAM_LIMIT' }); return; }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          const client = { res, taskId: id }; streams.add(client); req.on('close', () => streams.delete(client));
          event(client, 'snapshot', await safeSnapshot(await controller.store.read(id))); return;
        }
        const logMatch = /^\/release-panel\/api\/logs\/([a-f0-9-]{36})$/i.exec(url.pathname);
        if (req.method === 'GET' && logMatch) {
          const ref = logRefs.get(logMatch[1]); if (!ref) { json(res, 404, { error: 'LOG_REF_NOT_FOUND' }); return; }
          const file = path.join(runDirectory(ref.runId), 'journal.ndjson');
          const fd = await open(file, 'r'); let text;
          try { const info = await fd.stat(); const buffer = Buffer.alloc(Math.min(info.size, 16384)); await fd.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length)); text = buffer.toString('utf8'); }
          finally { await fd.close(); }
          json(res, 200, { lines: redactText(text).split('\n').slice(-100) }); return;
        }
        json(res, 404, { error: 'TASK_NOT_FOUND' }); return;
      }
      if (req.method !== 'GET' || !url.pathname.startsWith('/release-panel/')) { json(res, 404, { error: 'NOT_FOUND' }); return; }
      const relative = url.pathname === '/release-panel/' ? 'release-panel.html' : decodeURIComponent(url.pathname.slice('/release-panel/'.length));
      if (!/^(?:assets\/[a-zA-Z0-9._-]+\.(?:js|css|woff2?|svg)|release-panel\.html)$/.test(relative)) { json(res, 404, { error: 'NOT_FOUND' }); return; }
      const asset = await realpath(path.join(assetsRoot, relative)); const root = await realpath(assetsRoot);
      if (!asset.startsWith(`${root}${path.sep}`) || !(await stat(asset)).isFile()) throw new Error('INVALID_REQUEST');
      const ext = path.extname(asset); const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(asset));
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const code = error instanceof Error ? error.message : 'INVALID_REQUEST';
      json(res, code === 'TASK_REVISION_CONFLICT' ? 409 : code === 'REQUEST_TOO_LARGE' ? 413 : code === 'ENOENT' || (error instanceof Error && 'code' in error && error.code === 'ENOENT') ? 404 : 400, { error: /^[A-Z_]+$/.test(code) ? code : 'INVALID_REQUEST' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('PANEL_PORT_BUSY');
  origin = `http://127.0.0.1:${address.port}`;
  const heartbeat = setInterval(() => {
    for (const client of streams) client.res.write(': heartbeat\n\n');
    for (const [key, expiry] of capabilities) if (expiry < Date.now()) capabilities.delete(key);
    for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
  }, 10000); heartbeat.unref();
  return {
    origin, serverEpoch: epoch,
    bootstrapUrl(taskId) { validTaskId(taskId); const token = randomBytes(32).toString('hex'); capabilities.set(token, Date.now() + 60000); return `${origin}/release-panel/?task=${taskId}#${token}`; },
    async close() { clearInterval(heartbeat); controller.off('snapshot', onSnapshot); controller.off('observation', onObservation); for (const client of streams) client.res.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(() => resolve(undefined))); },
  };
}
