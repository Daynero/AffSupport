import { parseEnvFile } from './env-file.mjs';
const FLAGS = ['VITE_CATALOG_VIDEO_VARIANTS', 'SOTY_CATALOG_VIDEO_VARIANTS'];
/** Public experiment flags only; never return or log the rest of the env file. */
export function betaCatalogVideoFlag(contents) {
  const seen = new Set();
  for (const line of contents.split(/\r?\n/u)) {
    const key = line.trim().split('=', 1)[0]?.trim();
    if (!FLAGS.includes(key)) continue;
    if (!line.includes('=')) throw new Error('Beta catalog video flags must be true or false');
    if (seen.has(key)) throw new Error('Duplicate beta catalog video flag');
    seen.add(key);
  }
  const env = parseEnvFile(contents);
  const values = FLAGS.map(key => {
    const value = env[key] ?? 'false';
    if (value !== 'true' && value !== 'false')
      throw new Error('Beta catalog video flags must be true or false');
    return value;
  });
  if (values[0] !== values[1]) throw new Error('Beta catalog video flags must agree');
  return values[0];
}
