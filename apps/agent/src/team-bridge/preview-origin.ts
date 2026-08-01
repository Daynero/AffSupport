import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { SafeZipEntry } from '../landing-preview/archive.js';

export const LANDING_IFRAME_SANDBOX = 'allow-scripts';
export const LANDING_PREVIEW_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'self'",
  'frame-ancestors *'
].join('; ');

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4v': 'video/x-m4v',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8'
};

const NAVIGATION_GUARD = `<script id="wishly-preview-navigation-guard">
(() => {
  const allowed = value => {
    try { return new URL(value, location.href).origin === location.origin; } catch { return false; }
  };
  addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link && !allowed(link.getAttribute('href'))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      parent.postMessage({ type: 'wishly-preview:external-navigation-blocked' }, '*');
    }
  }, true);
  addEventListener('submit', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    parent.postMessage({ type: 'wishly-preview:form-blocked' }, '*');
  }, true);
  window.open = () => null;
})();
</script>`;

export interface LandingValidationRecord {
  sourceVersion: string | null;
  sourceChecksum: string | null;
  fingerprint: string;
  landingRoot: string;
}

export function createLandingValidationRecord(input: {
  sourceVersion: string | null;
  sourceChecksum: string | null;
  entries: readonly SafeZipEntry[];
  landingRoot: string;
}): LandingValidationRecord {
  const hash = createHash('sha256');
  hash.update(input.sourceVersion ?? '<null>').update('\0');
  hash.update(input.sourceChecksum ?? '<null>').update('\0');
  hash.update(input.landingRoot).update('\n');
  for (const entry of [...input.entries].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    hash
      .update(entry.path)
      .update('\0')
      .update(entry.directory ? 'd' : 'f')
      .update('\0')
      .update(String(entry.compressedSize))
      .update('\0')
      .update(String(entry.uncompressedSize))
      .update('\0')
      .update(String(entry.crc32))
      .update('\n');
  }
  return {
    sourceVersion: input.sourceVersion,
    sourceChecksum: input.sourceChecksum,
    fingerprint: hash.digest('hex'),
    landingRoot: input.landingRoot
  };
}

export function applyLandingValidation(
  material: { driveVersion: string | null; checksum: string | null; category: string | null },
  validation: LandingValidationRecord
) {
  if (
    material.driveVersion !== validation.sourceVersion ||
    material.checksum !== validation.sourceChecksum
  ) {
    return { category: 'archive' as const, state: null, version: null, fingerprint: null };
  }
  return {
    category: 'landing' as const,
    state: 'validated' as const,
    version: validation.sourceVersion,
    fingerprint: validation.fingerprint
  };
}

export function isAllowedPreviewNavigation(baseUrl: string, destination: string): boolean {
  try {
    const base = new URL(baseUrl);
    const target = new URL(destination, base);
    return target.origin === base.origin && target.pathname.startsWith(base.pathname);
  } catch {
    return false;
  }
}

/** Resolves an existing regular preview asset and rejects lexical and realpath escapes. */
export async function resolvePreviewAsset(root: string, relativePath: string): Promise<string> {
  if (relativePath.includes('\0') || relativePath.includes('\\')) throw new Error('ROOT_ESCAPE');
  const canonicalRoot = await realpath(root);
  const lexical = path.resolve(canonicalRoot, relativePath || '.');
  if (lexical !== canonicalRoot && !lexical.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('ROOT_ESCAPE');
  }
  const target = await realpath(lexical);
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('ROOT_ESCAPE');
  }
  const details = await stat(target);
  if (!details.isFile()) throw new Error('NOT_FOUND');
  return target;
}

interface LandingOriginSession {
  server: Server;
  root: string;
  capability: string;
  cleanupPath: string | null;
}

export interface LandingOriginResult {
  operationId: string;
  url: string;
  sandbox: typeof LANDING_IFRAME_SANDBOX;
}

export class LandingPreviewOrigin {
  readonly #sessions = new Map<string, LandingOriginSession>();

  async open(input: {
    operationId: string;
    root: string;
    entryFile: string;
    removeRootOnClose?: boolean;
    removePathOnClose?: string;
  }): Promise<LandingOriginResult> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(input.operationId)) throw new Error('INVALID_INPUT');
    await this.close(input.operationId);
    const canonicalRoot = await realpath(input.root);
    await resolvePreviewAsset(canonicalRoot, input.entryFile);
    const cleanupPath = input.removePathOnClose
      ? path.resolve(input.removePathOnClose)
      : input.removeRootOnClose
        ? canonicalRoot
        : null;
    const capability = randomBytes(24).toString('base64url');
    const server = createServer((request, response) => {
      void this.#serve(
        { server, root: canonicalRoot, capability, cleanupPath },
        input.entryFile,
        request.method ?? 'GET',
        request.url ?? '/',
        response
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('PREVIEW_ORIGIN_UNAVAILABLE');
      this.#sessions.set(input.operationId, {
        server,
        root: canonicalRoot,
        capability,
        cleanupPath
      });
      return {
        operationId: input.operationId,
        url: `http://127.0.0.1:${address.port}/${capability}/`,
        sandbox: LANDING_IFRAME_SANDBOX
      };
    } catch (error) {
      await closeServer(server);
      if (cleanupPath) await rm(cleanupPath, { recursive: true, force: true });
      throw error;
    }
  }

  busy(): boolean {
    return this.#sessions.size > 0;
  }

  async close(operationId: string): Promise<boolean> {
    const session = this.#sessions.get(operationId);
    if (!session) return false;
    this.#sessions.delete(operationId);
    await closeServer(session.server);
    if (session.cleanupPath) {
      await rm(session.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map(operationId => this.close(operationId)));
  }

  async #serve(
    session: LandingOriginSession,
    entryFile: string,
    method: string,
    rawUrl: string,
    response: import('node:http').ServerResponse
  ) {
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    try {
      const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
      const prefix = `/${session.capability}`;
      if (requestUrl.pathname !== prefix && !requestUrl.pathname.startsWith(`${prefix}/`)) {
        response.writeHead(404).end();
        return;
      }
      const encodedRelative = requestUrl.pathname.slice(prefix.length).replace(/^\/+/, '');
      const decodedRelative = decodeURIComponent(encodedRelative);
      const relative = decodedRelative || entryFile;
      const target = await resolvePreviewAsset(session.root, relative);
      const contentType = MIME_TYPES[path.extname(target).toLocaleLowerCase('en-US')];
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', LANDING_PREVIEW_CSP);
      response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Type', contentType ?? 'application/octet-stream');
      if (method === 'HEAD') {
        response.writeHead(200).end();
        return;
      }
      if (/\.html?$/iu.test(target)) {
        const html = await readFile(target, 'utf8');
        response.writeHead(200).end(injectNavigationGuard(html));
        return;
      }
      response.writeHead(200);
      createReadStream(target)
        .once('error', () => response.destroy())
        .pipe(response);
    } catch (error) {
      response
        .writeHead(error instanceof Error && error.message === 'ROOT_ESCAPE' ? 403 : 404)
        .end();
    }
  }
}

function injectNavigationGuard(html: string) {
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
  if (!doctype) return `${NAVIGATION_GUARD}${html}`;
  return `${html.slice(0, doctype[0].length)}${NAVIGATION_GUARD}${html.slice(doctype[0].length)}`;
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
