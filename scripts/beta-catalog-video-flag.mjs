import { readFileSync } from 'node:fs';
import { betaCatalogVideoFlag } from './lib/beta-catalog-video-flags.mjs';
try {
  process.stdout.write(betaCatalogVideoFlag(readFileSync(process.argv[2] ?? '.env.beta', 'utf8')));
} catch {
  // Do not include env contents, arbitrary values or paths in packaging output.
  process.stderr.write(
    'Invalid beta catalog video flags: use matching true/false values, default false.\n'
  );
  process.exitCode = 1;
}
