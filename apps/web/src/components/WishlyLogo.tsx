/**
 * The Wishly mark: a flowing W with a small wish spark. The same geometry is
 * used by the favicon, the macOS app icon, and the DMG background, so keep
 * the paths in sync with apps/web/public/favicon.svg when changing them.
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
        <linearGradient id="wishly-mark-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7557e8" />
          <stop offset="1" stopColor="#9b6ff3" />
        </linearGradient>
      </defs>
      <path
        d="M13 22 C14 31 16.5 43 21 43 C24.4 43 26.8 36.8 29.2 30.8 C30.6 27.3 31.2 25.2 32 25.2 C32.8 25.2 33.4 27.3 34.8 30.8 C37.2 36.8 39.6 43 43 43 C47.5 43 50 31 51 22"
        fill="none"
        stroke="url(#wishly-mark-gradient)"
        strokeWidth="6.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M49.5 10 C50.1 12.6 51.2 13.7 53.8 14.3 C51.2 14.9 50.1 16 49.5 18.6 C48.9 16 47.8 14.9 45.2 14.3 C47.8 13.7 48.9 12.6 49.5 10 Z"
        fill="#8b6df6"
      />
    </svg>
  );
}

export function WishlyLogo({ name }: { name: string }) {
  return (
    <span className="wishly-logo">
      <WishlyMark size={26} />
      <span className="wishly-wordmark">{name}</span>
    </span>
  );
}
