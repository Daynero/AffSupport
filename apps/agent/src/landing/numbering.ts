import path from 'node:path';
import type { LandingAsset } from '@video-compressor/shared';

/**
 * `img1`, `img2`, … and `vid1`, `vid2`, … in the order the landing was walked.
 *
 * Renumbering is asked for when a landing arrives with whatever names its designer used —
 * `Screenshot 2024-11-02 at 14.03.11.png`, `final_FINAL_v3 (copy).jpg`, names with spaces and
 * alphabets a server may or may not serve. Numbered, the folder is readable and every
 * reference to it is rewritten in the same pass that already rewrites the extensions.
 *
 * Two rules keep it safe:
 *
 * - **A file stays in its own folder.** Only the name changes, so every reference keeps the
 *   prefix it was written with — `../assets/`, `/img/`, `./` — and resolves exactly as before.
 * - **A name already taken is left alone.** A landing that already contains `img3.webp` keeps
 *   it, and the asset that would have claimed that name keeps its own; a collision is a file
 *   quietly overwritten, which is worse than an unnumbered file.
 *
 * Numbering counts every asset of its kind, including the ones that keep their names, so the
 * sequence has no holes in it and does not shift when one file is skipped.
 */
export function numberedRenames(
  assets: readonly LandingAsset[],
  taken: ReadonlySet<string>
): Map<string, string> {
  const renames = new Map<string, string>();
  const claimed = new Set(taken);
  const counters = { image: 0, video: 0 };
  for (const asset of assets) {
    if (asset.type !== 'image' && asset.type !== 'video') continue;
    // Where the file actually is now: an optimized image is already at its `.webp` name.
    const current = asset.newRelPath ?? asset.relPath;
    counters[asset.type] += 1;
    const prefix = asset.type === 'image' ? 'img' : 'vid';
    const directory = path.posix.dirname(current);
    const target = path.posix.join(
      directory === '.' ? '' : directory,
      `${prefix}${counters[asset.type]}${path.posix.extname(current)}`
    );
    if (target === current) continue;
    if (claimed.has(target)) continue;
    claimed.delete(current);
    claimed.add(target);
    renames.set(current, target);
  }
  return renames;
}
