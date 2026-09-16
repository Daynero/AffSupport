// Catalogue icons for the Soty web tools. They live in their own module so
// the tool registry can reference them without dragging page code along.

export function CompressorIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <rect x="5" y="7" width="22" height="18" rx="4" />
      <path d="m12 12 4 4-4 4m8-8-4 4 4 4" />
    </svg>
  );
}

export function LandingIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <rect x="5" y="6" width="22" height="20" rx="3" />
      <path d="M5 11h22M9 16h9m-9 4h6" />
      <path d="m21 20 2.5 2.5L27 18" />
    </svg>
  );
}

export function LandingPreviewIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <path d="M4.5 8.5A3.5 3.5 0 0 1 8 5h5l2.2 2.5H24A3.5 3.5 0 0 1 27.5 11v11A3.5 3.5 0 0 1 24 25.5H8A3.5 3.5 0 0 1 4.5 22z" />
      <path d="M9 17s2.8-4 7-4 7 4 7 4-2.8 4-7 4-7-4-7-4Z" />
      <circle cx="16" cy="17" r="1.8" />
    </svg>
  );
}

export function TranscriptionIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <path d="M8 12v8m4-12v16m4-12v8m4-14v20m4-14v8" />
    </svg>
  );
}

/** A space: three cells of a comb — where the work lies, not who sits in it (024). */
export function TeamWorkspaceIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <path d="M9.9 3.7 15.36 6.85 15.36 13.15 9.9 16.3 4.44 13.15 4.44 6.85Z" />
      <path d="M22.1 3.7 27.56 6.85 27.56 13.15 22.1 16.3 16.64 13.15 16.64 6.85Z" />
      <path d="M16 14.3 21.46 17.45 21.46 23.75 16 26.9 10.54 23.75 10.54 17.45Z" />
    </svg>
  );
}

export function StitcherIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <rect x="3" y="8" width="7" height="16" rx="1.5" />
      <rect x="22" y="8" width="7" height="16" rx="1.5" />
      <path d="M10 16h12" />
      <path d="m14.5 12.5-2 3.5 2 3.5m3-7 2 3.5-2 3.5" />
    </svg>
  );
}

export function TwoFactorIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <circle cx="12.5" cy="12.5" r="6" />
      <path d="m16.8 16.8 8.7 8.7" />
      <path d="m21.5 21.5-2.8 2.8" />
    </svg>
  );
}
