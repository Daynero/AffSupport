// Shared inline-SVG icons for team media actions. Every glyph is stroke-only and
// inherits the button's `color` via `stroke: currentColor` (see the
// `.team-media-action` rules in styles.css), so a single icon adapts to each
// coloured action variant without per-icon fills.

export type MediaActionKind = 'preview' | 'task' | 'copy-link' | 'open' | 'download' | 'transcribe';

export function MediaActionIcon({ kind }: { kind: MediaActionKind }) {
  if (kind === 'preview') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M2.2 10s2.65-4.55 7.8-4.55S17.8 10 17.8 10s-2.65 4.55-7.8 4.55S2.2 10 2.2 10Z" />
        <circle cx="10" cy="10" r="2.15" />
      </svg>
    );
  }
  if (kind === 'task') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M6.4 3.6h7.2a1.6 1.6 0 0 1 1.6 1.6v10.6a1.6 1.6 0 0 1-1.6 1.6H6.4a1.6 1.6 0 0 1-1.6-1.6V5.2a1.6 1.6 0 0 1 1.6-1.6Z" />
        <path d="M7.7 3.6a2.3 2.3 0 0 1 4.6 0M10 8.4v4.4M7.8 10.6h4.4" />
      </svg>
    );
  }
  if (kind === 'copy-link') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="m7.65 12.35 4.7-4.7M7.3 15.55l-1.1 1.1a3 3 0 0 1-4.25-4.25l3.05-3.05A3 3 0 0 1 9.25 9m3.45 2a3 3 0 0 1 .75-3.2l1.1-1.1a3 3 0 1 1 4.25 4.25L15.75 14a3 3 0 0 1-4.25 0" />
      </svg>
    );
  }
  if (kind === 'open') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M11.2 3.4h5.4v5.4M16.6 3.4 9.4 10.6M14 11.6v3.4a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6V7.6A1.6 1.6 0 0 1 5 6h3.4" />
      </svg>
    );
  }
  if (kind === 'download') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M10 2.8v9.2m0 0 3.2-3.2M10 12 6.8 8.8M3.4 14.7v1.15c0 .75.6 1.35 1.35 1.35h10.5c.75 0 1.35-.6 1.35-1.35V14.7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5.4 2.8h6.1l3 3v11.4H5.4a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6Z" />
      <path d="M11.5 2.8v3h3M6.8 10h6.4M6.8 13h4.5" />
    </svg>
  );
}
