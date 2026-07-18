import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { PRODUCTION_SITE_ORIGIN } from '../../packages/shared/src/release';

function currentRevision() {
  if (process.env.VITE_WEB_REVISION) return process.env.VITE_WEB_REVISION;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'development';
  }
}

/** Injects the centrally configured production origin into index.html
 * (Open Graph URLs), so the brand URL lives only in the shared release
 * config. */
function siteOriginPlugin(): Plugin {
  return {
    name: 'wishly-site-origin',
    transformIndexHtml(html) {
      return html.replaceAll('%SITE_ORIGIN%', PRODUCTION_SITE_ORIGIN);
    }
  };
}

export default defineConfig({
  plugins: [react(), siteOriginPlugin()],
  envDir: '../..',
  define: { 'import.meta.env.VITE_WEB_REVISION': JSON.stringify(currentRevision()) },
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:43117' } },
  build: { outDir: 'dist' }
});
