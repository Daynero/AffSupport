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

export function TranscriptionIcon() {
  return (
    <svg viewBox="0 0 32 32">
      <path d="M8 12v8m4-12v16m4-12v8m4-14v20m4-14v8" />
    </svg>
  );
}
