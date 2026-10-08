import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  root: import.meta.dirname,
  base: '/release-panel/',
  publicDir: false,
  envPrefix: 'RELEASE_PANEL_UNUSED_',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(import.meta.dirname, '../../release/automation/panel'),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(import.meta.dirname, 'release-panel.html') }
  }
});
