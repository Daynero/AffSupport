import { createReadStream } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const VIEWPORT = { width: 1440, height: 900 };
const NAVIGATION_TIMEOUT_MS = 20_000;
const MAX_SCREENSHOT_WIDTH = 4096;
const MAX_SCREENSHOT_HEIGHT = 30_000;
const MAX_SCREENSHOT_PIXELS = 40_000_000;
const MIME_TYPES: Record<string, string> = {
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

export interface LandingRenderResult {
  width: number;
  height: number;
  title: string | null;
  blockedExternalRequests: number;
  warning: string | null;
}

export class LandingPageRenderer {
  private browser: Browser | null = null;
  private executable: string | null = null;
  private availabilityError: string | null = null;

  async init() {
    try {
      this.executable = await resolveChromiumExecutable();
      this.availabilityError = null;
    } catch (error) {
      this.executable = null;
      this.availabilityError = message(error);
    }
  }

  availability() {
    return {
      available: Boolean(this.executable),
      error: this.executable ? null : this.availabilityError || 'Chromium renderer is unavailable.'
    };
  }

  async render(input: {
    root: string;
    entryFile: string;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<LandingRenderResult> {
    if (!this.executable) throw new Error(this.availability().error ?? 'Renderer unavailable.');
    throwIfAborted(input.signal);
    const browser = await this.getBrowser();
    const local = await createLandingServer(input.root, input.entryFile);
    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
        acceptDownloads: false,
        javaScriptEnabled: true,
        locale: 'en-US',
        colorScheme: 'light'
      });
      const origin = new URL(local.url).origin;
      let blockedExternalRequests = 0;
      await context.route('**/*', async route => {
        const requestUrl = route.request().url();
        let allowed: boolean;
        try {
          const parsed = new URL(requestUrl);
          allowed =
            parsed.origin === origin ||
            parsed.protocol === 'data:' ||
            parsed.protocol === 'blob:' ||
            parsed.protocol === 'about:';
        } catch {
          allowed = false;
        }
        if (allowed) await route.continue();
        else {
          blockedExternalRequests += 1;
          await route.abort('blockedbyclient');
        }
      });
      await context.routeWebSocket('**/*', async socket => {
        blockedExternalRequests += 1;
        await socket.close({ code: 1008, reason: 'Network disabled for local previews' });
      });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      page.on('dialog', dialog => void dialog.dismiss());
      page.on('download', download => void download.cancel());
      page.on('popup', popup => void popup.close());
      const pageErrors: string[] = [];
      page.on('pageerror', error => {
        if (pageErrors.length < 3) pageErrors.push(error.message);
      });
      await page.goto(local.url, { waitUntil: 'domcontentloaded' });
      throwIfAborted(input.signal);
      await settlePage(page, input.signal);
      const dimensions = await page.evaluate(() => ({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
          document.documentElement.clientWidth
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
          document.documentElement.clientHeight
        )
      }));
      const title = (await page.title()).trim() || null;
      const captureWidth = Math.max(1, Math.min(dimensions.width, MAX_SCREENSHOT_WIDTH));
      const captureHeight = Math.max(
        1,
        Math.min(
          dimensions.height,
          MAX_SCREENSHOT_HEIGHT,
          Math.floor(MAX_SCREENSHOT_PIXELS / captureWidth)
        )
      );
      const cropped = captureWidth < dimensions.width || captureHeight < dimensions.height;
      const screenshotOptions: Parameters<Page['screenshot']>[0] = {
        path: input.outputPath,
        type: 'webp',
        quality: 88,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        timeout: 30_000,
        signal: input.signal,
        style:
          'html { scroll-behavior: auto !important; } *, *::before, *::after { animation-delay: 0s !important; transition-delay: 0s !important; }'
      };
      if (cropped) {
        screenshotOptions.clip = {
          x: 0,
          y: 0,
          width: captureWidth,
          height: captureHeight
        };
      } else {
        screenshotOptions.fullPage = true;
      }
      await page.screenshot(screenshotOptions);
      const warnings: string[] = [];
      if (pageErrors.length) warnings.push('PAGE_SCRIPT_ERROR');
      if (cropped) warnings.push('PREVIEW_CROPPED');
      return {
        width: captureWidth,
        height: captureHeight,
        title,
        blockedExternalRequests,
        warning: warnings.join(',') || null
      };
    } finally {
      await context?.close().catch(() => {});
      await closeServer(local.server);
    }
  }

  async shutdown() {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }

  private async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    try {
      this.browser = await chromium.launch({
        headless: true,
        executablePath: this.executable ?? undefined,
        args: [
          '--disable-background-networking',
          '--disable-breakpad',
          '--disable-component-update',
          '--disable-sync',
          '--dns-prefetch-disable',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--no-first-run'
        ]
      });
      return this.browser;
    } catch (error) {
      this.availabilityError = `Chromium could not start: ${message(error)}`;
      throw new Error(this.availabilityError, { cause: error });
    }
  }
}

async function settlePage(page: Page, signal?: AbortSignal) {
  await page
    .evaluate(async () => {
      if ('fonts' in document) {
        await Promise.race([
          document.fonts.ready,
          new Promise<void>(resolve => window.setTimeout(resolve, 4000))
        ]);
      }
      const maximum = Math.min(
        120,
        Math.ceil(
          Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight) /
            Math.max(600, window.innerHeight * 0.8)
        )
      );
      for (let index = 0; index < maximum; index += 1) {
        const before = window.scrollY;
        window.scrollBy(0, Math.max(600, window.innerHeight * 0.8));
        await new Promise<void>(resolve => window.setTimeout(resolve, 45));
        if (window.scrollY === before) break;
      }
      window.scrollTo(0, 0);
      await new Promise<void>(resolve => window.setTimeout(resolve, 500));
    })
    .catch(() => {});
  throwIfAborted(signal);
}

async function createLandingServer(root: string, entryFile: string) {
  const canonicalRoot = await realpath(root);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const decoded = decodeURIComponent(requestUrl.pathname);
      const relative = decoded === '/' ? entryFile : decoded.replace(/^\/+/, '');
      const target = await realpath(path.resolve(canonicalRoot, relative));
      if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      await access(target);
      const details = await stat(target);
      if (!details.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-DNS-Prefetch-Control', 'off');
      if (/\.html?$/iu.test(target)) {
        response.setHeader(
          'Content-Security-Policy',
          "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'"
        );
      }
      response.setHeader(
        'Content-Type',
        MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
      );
      if (request.method === 'HEAD') {
        response.writeHead(200).end();
        return;
      }
      response.writeHead(200);
      createReadStream(target)
        .on('error', () => {
          if (!response.headersSent) response.writeHead(404);
          response.end();
        })
        .pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Could not start the local landing server.');
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server: Server) {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function resolveChromiumExecutable(): Promise<string> {
  const configured = process.env.WISHLY_CHROMIUM_PATH?.trim();
  if (configured) {
    await access(configured);
    return configured;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const agentRoot = path.resolve(here, '..', '..');
  try {
    const manifest = JSON.parse(
      await readFile(path.join(agentRoot, 'browser-runtime.json'), 'utf8')
    ) as { executableRelativePath?: unknown };
    if (typeof manifest.executableRelativePath === 'string') {
      const bundled = path.resolve(agentRoot, manifest.executableRelativePath);
      await access(bundled);
      return bundled;
    }
  } catch {
    // Source runs use Playwright's platform cache below.
  }
  const playwrightExecutable = chromium.executablePath();
  try {
    await access(playwrightExecutable);
    return playwrightExecutable;
  } catch {
    // Fall through to common browser installations for a friendlier dev setup.
  }
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : process.platform === 'win32'
        ? [
            path.join(
              process.env.PROGRAMFILES ?? '',
              'Google',
              'Chrome',
              'Application',
              'chrome.exe'
            ),
            path.join(
              process.env['PROGRAMFILES(X86)'] ?? '',
              'Microsoft',
              'Edge',
              'Application',
              'msedge.exe'
            )
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known installation.
    }
  }
  throw new Error('Chromium renderer is not installed. Reinstall Wishly to restore it.');
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown renderer error.';
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation cancelled.');
}
