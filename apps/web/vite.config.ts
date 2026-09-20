import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { PRODUCTION_SITE_ORIGIN } from '../../packages/shared/src/release';
import { supportEmail } from './src/lib/support';
import { staticPublicPages } from './src/static-public-pages';

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

/** Writes the crawler-readable copies of `/`, `/privacy` and `/terms` (see src/static-public-pages.ts). */
function staticPublicPagesPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'soty-static-public-pages',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const index = readFileSync(path.join(outDir, 'index.html'), 'utf8');
      for (const page of staticPublicPages(index, supportEmail)) {
        writeFileSync(path.join(outDir, page.fileName), page.html);
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), siteOriginPlugin(), staticPublicPagesPlugin()],
  envDir: '../..',
  define: { 'import.meta.env.VITE_WEB_REVISION': JSON.stringify(currentRevision()) },
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:43117' } },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        /**
         * Keep the heavy dependencies out of whatever chunk happens to
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
          // The component inventory is imported by every screen, so the library
          // behind it would otherwise land in whichever route chunk got there
          // first and be re-downloaded by the next one.
          if (
            /[\\/]node_modules[\\/](@heroui|react-aria|react-aria-components|@react-aria|@react-stately|@react-types|@internationalized|tailwind-variants|tailwind-merge)[\\/]/u.test(
              id
            )
          ) {
            return 'heroui';
          }
          return undefined;
        }
      }
    }
  }
});
