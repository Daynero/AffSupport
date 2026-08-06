import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { chromium } from 'playwright-core';
import { verifyIsolation } from './verify-isolation.mjs';
import { verifyLayout } from './verify-layout.mjs';

const baseUrl = 'http://127.0.0.1:4174';
const outputDirectory = new URL('../review-output', import.meta.url).pathname;

function waitForServer(attempts = 80) {
  return new Promise((resolve, reject) => {
    const check = remaining => {
      const request = get(baseUrl, response => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve(undefined);
        else retry(remaining);
      });
      request.on('error', () => retry(remaining));
      request.setTimeout(500, () => request.destroy());
    };
    const retry = remaining => {
      if (remaining <= 0) reject(new Error('Soty review preview did not start.'));
      else setTimeout(() => check(remaining - 1), 125);
    };
    check(attempts);
  });
}

async function accessibilityAudit(executablePath) {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/#/screen/home-tools?state=default&theme=light&locale=uk`, {
      waitUntil: 'networkidle'
    });
    await page.addScriptTag({ content: axe.source });
    const results = await page.evaluate(async () => globalThis.axe.run(document));
    const serious = results.violations.filter(item =>
      ['serious', 'critical'].includes(item.impact ?? '')
    );
    if (serious.length)
      throw new Error(
        `axe serious/critical violations: ${serious.map(item => item.id).join(', ')}`
      );
    await context.close();
    return {
      violations: results.violations.length,
      serious: 0,
      ids: results.violations.map(item => `${item.id}:${item.impact ?? 'unknown'}`),
      targets: results.violations.flatMap(item =>
        item.nodes.map(node => `${item.id}:${node.target.join(' ')}`)
      )
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const viteCli = fileURLToPath(new URL('../../../node_modules/vite/bin/vite.js', import.meta.url));
  const server = spawn(
    process.execPath,
    [viteCli, 'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort'],
    { cwd: new URL('..', import.meta.url), shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  server.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  try {
    await waitForServer();
    const executablePath = [
      process.env.SOTY_REVIEW_CHROMIUM_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      chromium.executablePath()
    ].find(candidate => candidate && existsSync(candidate));
    if (!executablePath)
      throw new Error('No Chromium executable is available for review verification.');
    const isolation = await verifyIsolation(baseUrl, executablePath);
    const layout = await verifyLayout(baseUrl, executablePath, outputDirectory);
    const accessibility = await accessibilityAudit(executablePath);
    process.stdout.write(`${JSON.stringify({ ok: true, isolation, layout, accessibility })}\n`);
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        server.kill('SIGKILL');
        resolve(undefined);
      }, 3000);
      timer.unref();
      server.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    if (server.exitCode && server.exitCode !== 0) process.stderr.write(stderr);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
