/**
 * The general «What's new» picture: the honeycomb with one cell lifting out and
 * an arrow coming down into it. Colours come from the stylesheet (classes), so
 * both themes draw it from the token layer.
 */
const HEX = 'M0,-46 L40,-23 L40,23 L0,46 L-40,23 L-40,-23 Z';

const CELLS: ReadonlyArray<readonly [number, number]> = [
  [-200, -40],
  [-120, -40],
  [-40, -40],
  [40, -40],
  [120, -40],
  [200, -40],
  [-240, 30],
  [-160, 30],
  [-80, 30],
  [80, 30],
  [160, 30],
  [240, 30],
  [-200, 100],
  [-120, 100],
  [-40, 100],
  [40, 100],
  [120, 100],
  [200, 100]
];

export function UpdateArt() {
  return (
    <svg viewBox="-320 -110 640 280" aria-hidden="true" focusable="false">
      <g className="update-art-grid">
        {CELLS.map(([x, y]) => (
          <path key={`${x}:${y}`} d={HEX} transform={`translate(${x} ${y})`} />
        ))}
      </g>
      <g className="update-art-cell" transform="translate(0 30) scale(1.35)">
        <path d={HEX} />
      </g>
      <g className="update-art-arrow" transform="translate(0 30)">
        <path d="M0,-34 L0,14" />
        <path d="M-17,-3 L0,14 L17,-3" />
        <path d="M-22,26 L22,26" />
      </g>
    </svg>
  );
}
