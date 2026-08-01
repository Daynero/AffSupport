// Catalogue icons for the Wishly web tools. They live in their own module so
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

export function TeamWorkspaceIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <circle cx="12" cy="11" r="4" />
      <circle cx="22.5" cy="13" r="3" />
      <path d="M5 25c.6-5 3.1-7.5 7-7.5s6.4 2.5 7 7.5M18.5 19c1.1-1.2 2.4-1.8 4-1.8 3 0 4.8 2 5.3 5.8" />
    </svg>
  );
}
