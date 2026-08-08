/**
 * Soty brand marks.
 *
 * `WishlyMark` (name kept so existing call sites stay untouched) is the Soty
 * honeycomb cell — a honey-gradient hexagon with a small honey spark. The same
 * geometry backs the favicon and app icon, so keep it in sync when changing.
 * `WishlyLogo` renders the full Soty wordmark lockup image.
 */
export function WishlyMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="wishly-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="soty-mark-honey" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc83d" />
          <stop offset="1" stopColor="#d98508" />
        </linearGradient>
      </defs>
      {/* Honeycomb cell — flat-top hexagon, rounded via a round-joined stroke */}
      <path
        d="M55 32 L43.5 51.9 L20.5 51.9 L9 32 L20.5 12.1 L43.5 12.1 Z"
        fill="url(#soty-mark-honey)"
        stroke="url(#soty-mark-honey)"
        strokeWidth="7"
        strokeLinejoin="round"
      />
      {/* Inset wall — a beveled inner cell for depth */}
      <path
        d="M45 32 L38 44.1 L24 44.1 L17 32 L24 19.9 L38 19.9 Z"
        fill="none"
        stroke="#fff8e5"
        strokeOpacity="0.34"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* Honey spark */}
      <path
        d="M44 15 C44.7 18 46 19.3 49 20 C46 20.7 44.7 22 44 25 C43.3 22 42 20.7 39 20 C42 19.3 43.3 18 44 15 Z"
        fill="#fff8e5"
      />
    </svg>
  );
}

export function WishlyLogo({ name }: { name: string }) {
  return (
    <span className="wishly-logo soty-logo-lockup">
      <img
        className="soty-wordmark-img soty-wordmark-img-light"
        src="/soty-header-logo-light.svg"
        alt={name}
      />
      <img
        className="soty-wordmark-img soty-wordmark-img-dark"
        src="/soty-header-logo-dark.svg"
        alt=""
        aria-hidden="true"
      />
    </span>
  );
}
