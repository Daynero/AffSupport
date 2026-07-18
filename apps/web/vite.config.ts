import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function currentRevision() {
  if (process.env.VITE_WEB_REVISION) return process.env.VITE_WEB_REVISION;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'development';
  }
}

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_WEB_REVISION': JSON.stringify(currentRevision()) },
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:43117' } },
  build: { outDir: 'dist' }
});
