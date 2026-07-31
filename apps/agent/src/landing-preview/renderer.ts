import { createReadStream } from 'node:fs';
import { access, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const VIEWPORT = { width: 1440, height: 900 };
const NAVIGATION_TIMEOUT_MS = 20_000;
const MAX_SCREENSHOT_WIDTH = 4096;
const MAX_SEGMENT_HEIGHT = 8000;
const MAX_DOCUMENT_HEIGHT = 250_000;
const MAX_TOTAL_SCREENSHOT_PIXELS = 120_000_000;
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
  segmentFiles: string[];
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
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
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
      const captureHeight = Math.max(1, Math.min(dimensions.height, MAX_DOCUMENT_HEIGHT));
      const scale = Math.min(
        1,
        MAX_SCREENSHOT_WIDTH / Math.max(1, dimensions.width),
        Math.sqrt(
          MAX_TOTAL_SCREENSHOT_PIXELS / Math.max(1, dimensions.width * Math.max(1, captureHeight))
        )
      );
      const captureWidth = Math.max(1, Math.round(dimensions.width * scale));
      const segmentCssHeight = Math.max(1, Math.floor(MAX_SEGMENT_HEIGHT / scale));
      const cropped = captureHeight < dimensions.height;
      const downscaled = scale < 0.999;
      await prepareForCapture(page);
      const segmentFiles = await captureSegments({
        page,
        outputPath: input.outputPath,
        width: dimensions.width,
        height: captureHeight,
        scale,
        segmentCssHeight,
        signal: input.signal
      });
      const outputHeight = segmentFiles.reduce((total, segment) => total + segment.height, 0);
      const warnings: string[] = [];
      if (pageErrors.length) warnings.push('PAGE_SCRIPT_ERROR');
      if (cropped) warnings.push('PREVIEW_CROPPED');
      if (downscaled) warnings.push('PREVIEW_DOWNSCALED');
      return {
        width: captureWidth,
        height: outputHeight,
        segmentFiles: segmentFiles.map(segment => segment.path),
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
      const wait = (milliseconds: number) =>
        new Promise<void>(resolve => window.setTimeout(resolve, milliseconds));
      const promoteLazyAssets = () => {
        for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
          image.loading = 'eager';
          const source =
            image.dataset.src ||
            image.dataset.original ||
            image.dataset.lazySrc ||
            image.getAttribute('data-lazy');
          if (source && (!image.getAttribute('src') || image.currentSrc.startsWith('data:'))) {
            image.src = source;
          }
          const sourceSet = image.dataset.srcset || image.getAttribute('data-lazy-srcset');
          if (sourceSet && !image.getAttribute('srcset')) image.srcset = sourceSet;
        }
        for (const source of document.querySelectorAll<HTMLSourceElement>('source')) {
          const sourceSet = source.dataset.srcset || source.getAttribute('data-lazy-srcset');
          if (sourceSet && !source.getAttribute('srcset')) source.srcset = sourceSet;
        }
        for (const element of document.querySelectorAll<HTMLElement>(
          '[data-bg], [data-background]'
        )) {
          const background = element.dataset.bg || element.dataset.background;
          if (background && !element.style.backgroundImage) {
            const escaped = background.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
            element.style.backgroundImage = `url("${escaped}")`;
          }
        }
      };
      if ('fonts' in document) {
        await Promise.race([document.fonts.ready, wait(4000)]);
      }
      promoteLazyAssets();

      const scrollContainers = [...document.querySelectorAll<HTMLElement>('body *')].filter(
        element => {
          const style = getComputedStyle(element);
          return (
            /auto|scroll/iu.test(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 32 &&
            element.clientHeight > 120
          );
        }
      );
      for (const element of scrollContainers.slice(0, 24)) {
        const step = Math.max(400, element.clientHeight * 0.8);
        for (
          let index = 0;
          index < 80 && element.scrollTop + element.clientHeight < element.scrollHeight;
          index += 1
        ) {
          element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + step);
          promoteLazyAssets();
          await wait(35);
        }
        element.scrollTop = 0;
      }

      const step = Math.max(600, window.innerHeight * 0.8);
      let stablePasses = 0;
      let previousHeight = 0;
      for (let index = 0; index < 180 && stablePasses < 3; index += 1) {
        promoteLazyAssets();
        const height = Math.max(
          document.body?.scrollHeight ?? 0,
          document.documentElement.scrollHeight
        );
        window.scrollTo(0, Math.min(height, window.scrollY + step));
        await wait(55);
        const atBottom = window.scrollY + window.innerHeight >= height - 2;
        stablePasses = atBottom && height === previousHeight ? stablePasses + 1 : 0;
        previousHeight = height;
      }

      for (const element of scrollContainers) {
        if (element.clientHeight < window.innerHeight * 0.55) continue;
        element.style.setProperty('overflow-y', 'visible', 'important');
        element.style.setProperty('max-height', 'none', 'important');
        element.style.setProperty('height', 'auto', 'important');
      }
      window.scrollTo(0, 0);
      promoteLazyAssets();
      const pendingImages = [...document.images]
        .filter(image => !image.complete)
        .map(
          image =>
            new Promise<void>(resolve => {
              const complete = () => resolve();
              image.addEventListener('load', complete, { once: true });
              image.addEventListener('error', complete, { once: true });
            })
        );
      await Promise.race([Promise.allSettled(pendingImages), wait(6000)]);
      await wait(350);
    })
    .catch(() => {});
  throwIfAborted(signal);
}

async function prepareForCapture(page: Page) {
  await page.addStyleTag({
    content:
      'html { scroll-behavior: auto !important; } *, *::before, *::after { animation-play-state: paused !important; caret-color: transparent !important; transition: none !important; }'
  });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const video of document.querySelectorAll<HTMLVideoElement>('video')) video.pause();
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      if (element.scrollTop) element.scrollTop = 0;
      if (element.scrollLeft) element.scrollLeft = 0;
    }
  });
  await page.waitForTimeout(100);
}

async function captureSegments(input: {
  page: Page;
  outputPath: string;
  width: number;
  height: number;
  scale: number;
  segmentCssHeight: number;
  signal?: AbortSignal;
}) {
  const session = await input.page.context().newCDPSession(input.page);
  const segments: Array<{ path: string; height: number }> = [];
  const generatedFiles: string[] = [];
  try {
    for (let top = 0, index = 0; top < input.height; index += 1) {
      throwIfAborted(input.signal);
      const cssHeight = Math.min(input.segmentCssHeight, input.height - top);
      const target = segmentOutputPath(input.outputPath, index);
      const response = (await session.send('Page.captureScreenshot', {
        format: 'webp',
        quality: 88,
        fromSurface: true,
        captureBeyondViewport: true,
        optimizeForSpeed: false,
        clip: { x: 0, y: top, width: input.width, height: cssHeight, scale: input.scale }
      })) as { data?: string };
      const bytes = Buffer.from(response.data ?? '', 'base64');
      if (
        bytes.length < 32 ||
        bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.toString('ascii', 8, 12) !== 'WEBP'
      ) {
        throw new Error('Chromium returned an empty or invalid landing preview.');
      }
      await writeFile(target, bytes);
      generatedFiles.push(target);
      segments.push({ path: target, height: Math.max(1, Math.round(cssHeight * input.scale)) });
      top += cssHeight;
    }
    if (!segments.length) throw new Error('Chromium did not capture the landing preview.');
    return segments;
  } catch (error) {
    await Promise.all(generatedFiles.map(file => rm(file, { force: true }).catch(() => {})));
    throw error;
  } finally {
    await session.detach().catch(() => {});
  }
}

function segmentOutputPath(outputPath: string, index: number) {
  if (index === 0) return outputPath;
  const extension = path.extname(outputPath);
  return `${outputPath.slice(0, -extension.length)}.${index}${extension}`;
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
