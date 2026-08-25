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
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        /**
         * Keep the two heavy dependencies out of whatever chunk happens to
         * reference them first.
         *
         * Without this the bundler attaches a shared dependency to an arbitrary
         * module in the graph — the Supabase client ended up inside a chunk
         * named after the logo component, 115 kB of it, downloaded on the first
         * screen by someone who had not signed in. Naming them makes the split
         * a decision rather than an accident, and lets the browser cache them
         * across releases that do not change them.
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/u.test(id)) return 'react';
          if (id.includes('@supabase')) return 'supabase';
          return undefined;
        }
      }
    }
  }
});
