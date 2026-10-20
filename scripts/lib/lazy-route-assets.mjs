/**
 * @typedef {{file: string, imports: string[], dynamicImports: string[], css: string[], isEntry: boolean, isDynamicEntry: boolean}} Chunk
 */

/** @param {unknown} value @returns {Record<string, Chunk>} */
function parseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a Vite manifest object');
  }
  /** @type {Record<string, Chunk>} */
  const chunks = Object.create(null);
  const safeFile = file =>
    typeof file === 'string' &&
    file.length > 0 &&
    !file.startsWith('/') &&
    !/^[a-z]:/iu.test(file) &&
    !file.includes('\\') &&
    !file.split('/').some(part => part === '..' || part === '.' || part === '');
  const strings = (raw, field) => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every(item => typeof item === 'string')) {
      throw new Error(`Invalid manifest ${field}`);
    }
    return raw;
  };
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Invalid manifest chunk ${key}`);
    }
    if (!('file' in raw) || !safeFile(raw.file)) {
      throw new Error(`Invalid manifest file for ${key}`);
    }
    const record = /** @type {Record<string, unknown>} */ (raw);
    const css = strings(record.css, 'css');
    if (!css.every(safeFile)) throw new Error(`Invalid manifest CSS for ${key}`);
    chunks[key] = {
      file: /** @type {string} */ (record.file),
      imports: strings(record.imports, 'imports'),
      dynamicImports: strings(record.dynamicImports, 'dynamicImports'),
      css,
      isEntry: record.isEntry === true,
      isDynamicEntry: record.isDynamicEntry === true
    };
  }
  for (const chunk of Object.values(chunks)) {
    for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!Object.hasOwn(chunks, dependency)) {
        throw new Error(`Missing manifest dependency ${dependency}`);
      }
    }
  }
  return chunks;
}

/**
 * Assets that cannot be reached without taking this route's dynamic-import edge.
 * Descendant lazy panels count too. Anything reachable from another HTML entry,
 * another route, or a static import of this route remains shared/global.
 * Unmapped output assets are never deducted by this helper.
 *
 * @param {unknown} manifest
 * @param {string} routeKey Exact source key, not an output chunk-name regex.
 * @returns {{rootFile: string, files: string[], reachableFiles: string[], sharedFiles: string[]}}
 */
export function exclusiveLazyRouteAssets(manifest, routeKey) {
  const chunks = parseManifest(manifest);
  const route = chunks[routeKey];
  if (!route || !route.isDynamicEntry || route.isEntry) {
    throw new Error(`Expected a lazy route manifest entry: ${routeKey}`);
  }
  const entries = Object.keys(chunks).filter(key => chunks[key].isEntry);
  if (entries.length === 0) throw new Error('Manifest has no application entry');

  const walk = (roots, skipRoute) => {
    const seen = new Set();
    const files = new Set();
    const pending = [...roots];
    while (pending.length) {
      const key = pending.pop();
      if (seen.has(key)) continue;
      seen.add(key);
      const chunk = chunks[key];
      for (const file of [chunk.file, ...chunk.css]) {
        if (/\.(?:js|css)$/u.test(file)) files.add(file);
      }
      pending.push(...chunk.imports);
      pending.push(...chunk.dynamicImports.filter(key => !skipRoute || key !== routeKey));
    }
    return files;
  };
  const reachable = walk([routeKey], false);
  const outside = walk(entries, true);
  const files = [...reachable].filter(file => !outside.has(file)).sort();
  if (!files.includes(route.file)) {
    throw new Error(`Route is statically reachable outside its lazy boundary: ${routeKey}`);
  }
  // A disconnected manifest record is not evidence of a live lazy route.
  if (!walk(entries, false).has(route.file)) {
    throw new Error(`Lazy route is unreachable from application entries: ${routeKey}`);
  }
  return {
    rootFile: route.file,
    files,
    reachableFiles: [...reachable].sort(),
    sharedFiles: [...reachable].filter(file => outside.has(file)).sort()
  };
}

/** @param {string[]} files @param {(file: string) => number} sizeOf */
export function sumAssetBytes(files, sizeOf) {
  return [...new Set(files)].reduce((total, file) => {
    const bytes = sizeOf(file);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`Invalid measured asset size: ${file}`);
    }
    return total + bytes;
  }, 0);
}
