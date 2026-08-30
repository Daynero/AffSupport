/**
 * The app's icon system (owner, 2026-08-30).
 *
 * WHERE ICONS COME FROM: lucide-react — always prefer an existing lucide icon
 * over drawing one. DEFAULTS: size={ICON_SIZE} (20) and
 * strokeWidth={ICON_STROKE} (1.75) unless a spot genuinely needs another
 * scale; import the constants from here so every icon stays consistent.
 *
 * Vocabulary: lucide-react is the app's icon system — thin 24px strokes,
 * round caps — an open (ISC) set drawn in the same restrained spirit as
 * SF Symbols. Anything it does not cover is drawn here by hand in the same
 * convention: viewBox 24, hairline strokes (1.5), round caps and joins.
 * Where meaning needs colour, it is a soft translucent wash, never a slab:
 * green is what stays visible, red is what the crop takes away.
 */

const GREEN = '#34c759';
const RED = '#ff453a';

function Pictogram({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="pictogram"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** The 9:16 phone frame every fit icon shares. */
function PhoneFrame() {
  return (
    <>
      <rect x="7" y="2.75" width="10" height="18.5" rx="2.5" />
      <path d="M10.6 5h2.8" strokeWidth="1.2" />
    </>
  );
}

/** Fill & crop: the picture is wider than the screen; the red ears are lost. */
export function FitCoverIcon() {
  return (
    <Pictogram>
      {/* the cropped ears — a soft red wash outside the frame */}
      <rect x="3.4" y="8.6" width="3.6" height="7.4" rx="1" fill={RED} fillOpacity="0.28" stroke="none" />
      <rect x="17" y="8.6" width="3.6" height="7.4" rx="1" fill={RED} fillOpacity="0.28" stroke="none" />
      {/* the visible part — a soft green wash inside */}
      <rect x="7.9" y="8.6" width="8.2" height="7.4" rx="1" fill={GREEN} fillOpacity="0.32" stroke="none" />
      {/* the picture's own outline, running past both edges */}
      <rect x="3.4" y="8.6" width="17.2" height="7.4" rx="1.4" stroke={GREEN} strokeOpacity="0.8" strokeWidth="1.2" />
      <PhoneFrame />
    </Pictogram>
  );
}

/** Fit completely: the whole picture inside, air above and below. */
export function FitContainIcon() {
  return (
    <Pictogram>
      <rect x="8.8" y="9.3" width="6.4" height="5.8" rx="1.2" fill={GREEN} fillOpacity="0.32" stroke={GREEN} strokeOpacity="0.8" strokeWidth="1.2" />
      <PhoneFrame />
    </Pictogram>
  );
}

/** Stretch: the picture pulled to the screen's edges. */
export function FitStretchIcon() {
  return (
    <Pictogram>
      <rect x="8.5" y="6.7" width="7" height="12.6" rx="1.4" fill={GREEN} fillOpacity="0.32" stroke={GREEN} strokeOpacity="0.8" strokeWidth="1.2" />
      <PhoneFrame />
    </Pictogram>
  );
}

export const ICON_SIZE = 20;
export const ICON_STROKE = 1.75;
