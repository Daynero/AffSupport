/**
 * 074 US2 — what «What's new» says about a version.
 *
 * The signed release manifest carries one short summary and no picture, and its
 * format belongs to the release runner; a picture is not worth changing what is
 * signed. A version that has an entry here gets its own picture and points; any
 * other falls back to the manifest's summary and the general illustration.
 *
 * Add an entry when a release is cut. `image` is a path under `apps/web/public/`.
 */
export interface ReleaseHighlight {
  image?: string;
  uk: { title?: string; points: string[] };
  en: { title?: string; points: string[] };
}

export const RELEASE_HIGHLIGHTS: Readonly<Record<string, ReleaseHighlight>> = {};

export function releaseHighlight(version: string | null | undefined): ReleaseHighlight | null {
  if (!version) return null;
  return RELEASE_HIGHLIGHTS[version] ?? null;
}
