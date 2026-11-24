/**
 * The brand's own loaders (moved out of the pre-021 shim, 070 T035).
 *
 * They are not controls, so they are not the inventory's: a loader the shape of
 * the work — ribbons compressing into one for a conversion, a waveform for a
 * transcription — is something only this product draws. The inventory's
 * `Spinner` is for everything that is merely waiting.
 */

/** Soty conversion loader: three ribbons calmly compress into one.
 * Pure SVG + CSS transforms, sized for the status area. */
export function SotyLoader({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="soty-loader"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        className="ribbon-top"
        x="3"
        y="4"
        width="14"
        height="2.6"
        rx="1.3"
        fill="currentColor"
      />
      <rect
        className="ribbon-center"
        x="3"
        y="8.7"
        width="14"
        height="2.6"
        rx="1.3"
        fill="currentColor"
      />
      <rect
        className="ribbon-bottom"
        x="3"
        y="13.4"
        width="14"
        height="2.6"
        rx="1.3"
        fill="currentColor"
      />
    </svg>
  );
}

/** Compact speech waveform for active transcription states. */
export function TranscriptionLoader({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="transcription-loader"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="wave-bar" x="1" y="5" width="2" height="6" rx="1" fill="currentColor" />
      <rect className="wave-bar" x="5" y="2" width="2" height="12" rx="1" fill="currentColor" />
      <rect className="wave-bar" x="9" y="4" width="2" height="8" rx="1" fill="currentColor" />
      <rect className="wave-bar" x="13" y="6" width="2" height="4" rx="1" fill="currentColor" />
    </svg>
  );
}

/** Calm staggered dots for the estimation state — intentionally lighter
 * than the conversion loader. */
export function SotyDots() {
  return (
    <span className="soty-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
