import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

export const layoutViewports = [
  { id: '320x568', width: 320, height: 568 },
  { id: '390x844', width: 390, height: 844 },
  { id: '768x1024', width: 768, height: 1024 },
  { id: '1024x768', width: 1024, height: 768 },
  { id: '1440x900', width: 1440, height: 900 }
];

const surfaces = [
  'home-tools',
  'compressor',
  'landing-optimizer',
  'transcription',
  'team-workspace'
];

export async function verifyLayout(baseUrl, executablePath, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  let screenshots = 0;
  try {
    for (const viewport of layoutViewports) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
        const page = await context.newPage();
        for (const surface of surfaces) {
          await page.goto(
            `${baseUrl}/#/screen/${surface}?state=default&theme=${theme}&locale=en-long`,
            { waitUntil: 'networkidle' }
          );
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth
          );
          if (overflow) throw new Error(`Horizontal overflow: ${surface}/${theme}/${viewport.id}`);
          const focusable = page
            .locator('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled])')
            .first();
          if (await focusable.count()) {
            await focusable.focus();
            const outline = await focusable.evaluate(node => getComputedStyle(node).outlineStyle);
            if (outline === 'none')
              throw new Error(`Invisible focus: ${surface}/${theme}/${viewport.id}`);
          }
          await page.screenshot({
            path: `${outputDirectory}/soty-ui-r01--${surface}--default--${theme}--${viewport.id}--reduce.png`,
            fullPage: true
          });
          screenshots++;
        }
        await context.close();
      }
    }
    return { screenshots };
  } finally {
    await browser.close();
  }
}
