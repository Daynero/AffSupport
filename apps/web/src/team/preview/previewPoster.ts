/**
 * The picture a file already showed, kept for the viewer that opens it (070, phase 9е).
 *
 * A tile has the file's thumbnail on screen long before the viewer has a byte of the video: its
 * shape is the video's shape, and the picture itself is the first frame a person expects to see.
 * The viewer used to know neither — it opened as a short bar with a sentence in it, then jumped
 * to the clip's size once the clip told it — so the tile leaves both here, by file, and the
 * viewer reads them as its first guess.
 *
 * Memory only, and bounded: an address carries a short-lived session token and is never worth
 * keeping past the page.
 */
export interface PreviewPoster {
  src: string;
  /** Width over height. */
  aspect: number;
}

const LIMIT = 400;
const posters = new Map<string, PreviewPoster>();

export function rememberPreviewPoster(materialId: string, image: HTMLImageElement | null) {
  if (!image || !image.naturalWidth || !image.naturalHeight) return;
  const poster = {
    src: image.currentSrc || image.src,
    aspect: image.naturalWidth / image.naturalHeight
  };
  posters.delete(materialId);
  posters.set(materialId, poster);
  if (posters.size > LIMIT) {
    const oldest = posters.keys().next().value;
    if (oldest !== undefined) posters.delete(oldest);
  }
}

export function previewPoster(materialId: string): PreviewPoster | null {
  return posters.get(materialId) ?? null;
}

/** Tests start from nothing. */
export function forgetPreviewPosters() {
  posters.clear();
}
