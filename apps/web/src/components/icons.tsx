/**
 * The app's shared pictogram base (owner, 2026-08-30): small schematic icons
 * that explain a behaviour visually — a 9:16 screen and how the image sits in
 * it — so controls read at a glance in any language. Words move to tooltips.
 *
 * Conventions: 24×24 viewBox, stroke = currentColor, 1.6 stroke width, no
 * fills except deliberate accents; every icon takes the size via CSS (1em).
 */

/** A 9:16 frame filled edge-to-edge; the picture overflows and is cropped. */
export function FitCoverIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pictogram">
      <rect x="7" y="3" width="10" height="18" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {/* the picture, wider than the frame, cropped by it */}
      <path
        d="M4 9.5h16M4 14.5h16"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="2 2"
        opacity="0.55"
      />
      <rect x="8.4" y="8" width="7.2" height="8" rx="0.8" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

/** The whole picture inside the 9:16 frame, empty bands above and below. */
export function FitContainIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pictogram">
      <rect x="7" y="3" width="10" height="18" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="8.4" y="9" width="7.2" height="6" rx="0.8" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

/** The picture stretched to the frame's edges (distorted). */
export function FitStretchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pictogram">
      <rect x="7" y="3" width="10" height="18" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="8.4" y="4.4" width="7.2" height="15.2" rx="0.8" fill="currentColor" opacity="0.85" />
      {/* stretch arrows */}
      <path d="M12 6.6v-1m0 13v1" stroke="#0b0b12" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
