import type { ReactNode } from 'react';
import type { TeamMaterialRowKind } from '@video-compressor/shared';

/**
 * One drawn glyph per row kind.
 *
 * The explorer used emoji, which is the one thing in this interface that is
 * not ours: each platform draws its own, at its own weight and colour, so a
 * grid of files looked like a sticker sheet next to the line icons everywhere
 * else. These inherit `currentColor` and the surrounding font size, so a tile,
 * a list row and the preview pane can all ask for the size they want.
 */
const PATHS: Record<TeamMaterialRowKind, ReactNode> = {
  folder: (
    <path d="M3 7.2c0-.9.7-1.6 1.6-1.6h3.5c.5 0 1 .2 1.3.6l1 1.2h6c.9 0 1.6.7 1.6 1.6v7.4c0 .9-.7 1.6-1.6 1.6H4.6c-.9 0-1.6-.7-1.6-1.6V7.2Z" />
  ),
  image: (
    <>
      <rect x="3" y="4.6" width="18" height="14.8" rx="2.2" />
      <circle cx="8.6" cy="9.6" r="1.7" />
      <path d="m4 16.4 4.3-4a1.6 1.6 0 0 1 2.2 0l3 2.8m0 0 2-1.9a1.6 1.6 0 0 1 2.2 0l2.3 2.2m-6.5-.3 3.2 3.2" />
    </>
  ),
  video: (
    <>
      <rect x="2.8" y="5.4" width="13.4" height="13.2" rx="2.2" />
      <path d="m16.2 10.4 4-2.4c.5-.3 1.2 0 1.2.7v6.6c0 .7-.7 1-1.2.7l-4-2.4z" />
    </>
  ),
  landing: (
    <>
      <rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.2" />
      <path d="M3.2 9.2h17.6M7 6.8h.01M9.6 6.8h.01" />
    </>
  ),
  archive: (
    <>
      <path d="M3.4 7.6h17.2v10.2c0 1-.8 1.8-1.8 1.8H5.2c-1 0-1.8-.8-1.8-1.8z" />
      <path d="M2.6 4.6h18.8v3H2.6zM12 10.4v3.4" />
    </>
  ),
  transcript: (
    <>
      <path d="M6 3.4h7.6L19 8.8v10c0 1-.8 1.8-1.8 1.8H6c-1 0-1.8-.8-1.8-1.8V5.2c0-1 .8-1.8 1.8-1.8Z" />
      <path d="M13.4 3.6v5.2H19M8 13h8M8 16.4h5.4" />
    </>
  ),
  document: (
    <>
      <path d="M6 3.4h7.6L19 8.8v10c0 1-.8 1.8-1.8 1.8H6c-1 0-1.8-.8-1.8-1.8V5.2c0-1 .8-1.8 1.8-1.8Z" />
      <path d="M13.4 3.6v5.2H19" />
    </>
  ),
  shortcut: (
    <>
      <path d="M4.4 12.6v5.2c0 1 .8 1.8 1.8 1.8h11.6c1 0 1.8-.8 1.8-1.8V6.2c0-1-.8-1.8-1.8-1.8h-5.2" />
      <path d="M20 4.4 10.6 13.8M20 4.4v5M20 4.4h-5" />
    </>
  ),
  other: (
    <>
      <rect x="4" y="3.6" width="16" height="16.8" rx="2.2" />
      <path d="M8 8.6h8M8 12h8M8 15.4h5" />
    </>
  )
};

/** Kinds drawn as a filled shape rather than a stroked outline. */
const FILLED: ReadonlySet<TeamMaterialRowKind> = new Set(['folder']);

export function KindIcon({ kind, className }: { kind: TeamMaterialRowKind; className?: string }) {
  const filled = FILLED.has(kind);
  return (
    <svg
      className={className ? `team-kind-icon ${className}` : 'team-kind-icon'}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[kind]}
    </svg>
  );
}
