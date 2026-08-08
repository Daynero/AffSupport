/** Soty brand marks rendered from the current product icon and wordmark. */
export function SotyMark({ size = 24 }: { size?: number }) {
  return (
    <img
      className="soty-mark"
      src="/soty-app-icon.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}

export function SotyLogo({ name }: { name: string }) {
  return (
    <span className="soty-logo-lockup">
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
