/**
 * The app's icon system (owner, 2026-08-30).
 *
 * WHERE ICONS COME FROM: lucide-react — always prefer an existing lucide icon
 * over drawing one. DEFAULTS: size={ICON_SIZE} (20) and
 * strokeWidth={ICON_STROKE} (1.75) unless a spot genuinely needs another
 * scale; import the constants from here so every icon stays consistent.
 * COMFORT RULE (owner): 20px is the comfortable icon size — when a control
 * feels cramped, grow the button/plate under the icon, never shrink the icon.
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
      <rect
        x="3.4"
        y="8.6"
        width="3.6"
        height="7.4"
        rx="1"
        fill={RED}
        fillOpacity="0.28"
        stroke="none"
      />
      <rect
        x="17"
        y="8.6"
        width="3.6"
        height="7.4"
        rx="1"
        fill={RED}
        fillOpacity="0.28"
        stroke="none"
      />
      {/* the visible part — a soft green wash inside */}
      <rect
        x="7.9"
        y="8.6"
        width="8.2"
        height="7.4"
        rx="1"
        fill={GREEN}
        fillOpacity="0.32"
        stroke="none"
      />
      {/* the picture's own outline, running past both edges */}
      <rect
        x="3.4"
        y="8.6"
        width="17.2"
        height="7.4"
        rx="1.4"
        stroke={GREEN}
        strokeOpacity="0.8"
        strokeWidth="1.2"
      />
      <PhoneFrame />
    </Pictogram>
  );
}

/** Fit completely: the whole picture inside, air above and below. */
export function FitContainIcon() {
  return (
    <Pictogram>
      <rect
        x="8.8"
        y="9.3"
        width="6.4"
        height="5.8"
        rx="1.2"
        fill={GREEN}
        fillOpacity="0.32"
        stroke={GREEN}
        strokeOpacity="0.8"
        strokeWidth="1.2"
      />
      <PhoneFrame />
    </Pictogram>
  );
}

/** Stretch: the picture pulled to the screen's edges. */
export function FitStretchIcon() {
  return (
    <Pictogram>
      <rect
        x="8.5"
        y="6.7"
        width="7"
        height="12.6"
        rx="1.4"
        fill={GREEN}
        fillOpacity="0.32"
        stroke={GREEN}
        strokeOpacity="0.8"
        strokeWidth="1.2"
      />
      <PhoneFrame />
    </Pictogram>
  );
}

/**
 * 064: the mark of чарунки, the AI credits — an AI sparkle held in a honeycomb cell (owner,
 * 2026-11-22). No letters, so it reads the same in every language; the cell makes it Soty's and
 * a currency, where a free sparkle stays the assistant's own icon. The frame weighs 2 to sit with
 * the semibold numbers beside it; the sparkle is filled so it does not close into a cross at 14 px.
 */
export function CreditIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 3.05a2 2 0 0 1 2 0l6.25 3.61a2 2 0 0 1 1 1.73v7.22a2 2 0 0 1-1 1.73L13 20.95a2 2 0 0 1-2 0l-6.25-3.61a2 2 0 0 1-1-1.73V8.39a2 2 0 0 1 1-1.73Z" />
      <path
        d="M12 5.8C12.93 11.07 12.93 11.07 18.2 12C12.93 12.93 12.93 12.93 12 18.2C11.07 12.93 11.07 12.93 5.8 12C11.07 11.07 11.07 11.07 12 5.8Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export const ICON_SIZE = 20;
export const ICON_STROKE = 1.75;
