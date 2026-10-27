import { rmSync } from 'node:fs';

// TypeScript does not remove outputs whose source was deleted. Packaging copies
// this whole directory, so build from an empty, repository-owned output tree.
rmSync(new URL('../apps/agent/dist/', import.meta.url), {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100
});
