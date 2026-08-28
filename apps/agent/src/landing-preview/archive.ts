/**
 * Landing previews use the platform archive boundary rather than owning a
 * second ZIP implementation. Keep this feature-facing module as the stable
 * import surface for the scanner, catalog and team bridge.
 */
export {
  extractZipSafely,
  inspectZip,
  type SafeZipEntry,
  type ZipInspection
} from '../platform/zip.js';
