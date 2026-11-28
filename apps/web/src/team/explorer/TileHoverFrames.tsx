import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { SPACE_DERIVATIVE_SPRITE } from '@video-compressor/shared';
import { prefersReducedMotion } from '../../lib/navigation';

/**
 * 057 T123 (US7, research R5): a video's frames under the pointer, on its tile in an R2 space.
 *
 * The browser that uploaded the clip (or the agent, T047/T121) made one sprite of
 * `SPACE_DERIVATIVE_SPRITE.frames` frames, `columns` wide, beside the poster. Moving across the
 * tile shows the frame at that point of the clip — left is the start, right the end — and a thin
 * line under it says where; leaving puts the poster back. Nothing is fetched until the pointer
 * first rests on the tile, and the sprite is one picture under an immutable address, so a grid
 * of two hundred clips costs nothing until someone looks.
 *
 * Only a mouse or a pen: a touch is a press, and the tile opens. With reduced motion asked for,
 * frames do not change under the pointer at all — the poster stands, as it does everywhere.
 * A clip without a sprite (made before T047, or by a browser that could not) shows its poster
 * as before; the failure is remembered for the session and asked once more after the address is
 * refreshed (`onUnavailable`, the same single retry as every R2 picture).
 */

const loaded = new Map<string, number>();
const failed = new Set<string>();

/** Forgets what this session learned about sprites (tests; a sign-out drops the addresses). */
export function clearTileHoverFrames(): void {
  loaded.clear();
  failed.clear();
}

export function TileHoverFrames({
  url,
  onUnavailable
}: {
  /** The sprite's address, or null when the file has none to offer. */
  url: string | null;
  /** The address was refused: the tile may build the next one from a fresh grant. */
  onUnavailable?: () => void;
}) {
  const [aspect, setAspect] = useState<number | null>(() =>
    url ? (loaded.get(url) ?? null) : null
  );
  const [frame, setFrame] = useState<number | null>(null);
  const [, setRefused] = useState(0);
  const asked = useRef(false);
  const latest = useRef(url);
  latest.current = url;

  useEffect(() => {
    asked.current = false;
    setFrame(null);
    setAspect(url ? (loaded.get(url) ?? null) : null);
  }, [url]);

  if (!url || failed.has(url)) return null;

  const load = () => {
    if (asked.current || loaded.has(url)) return;
    asked.current = true;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      const { columns, frames } = SPACE_DERIVATIVE_SPRITE;
      const rows = Math.ceil(frames / columns);
      const cell =
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? image.naturalWidth / columns / (image.naturalHeight / rows)
          : 16 / 9;
      loaded.set(url, cell);
      if (latest.current === url) setAspect(cell);
    };
    image.onerror = () => {
      failed.add(url);
      if (latest.current !== url) return;
      setRefused(value => value + 1);
      onUnavailable?.();
    };
    image.src = url;
  };

  const follow = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.pointerType === 'touch' || prefersReducedMotion()) return;
    load();
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const at = Math.min(0.9999, Math.max(0, (event.clientX - box.left) / box.width));
    setFrame(Math.floor(at * SPACE_DERIVATIVE_SPRITE.frames));
  };

  const { columns, frames } = SPACE_DERIVATIVE_SPRITE;
  const rows = Math.ceil(frames / columns);
  const showing = aspect !== null && frame !== null;
  const column = showing ? frame % columns : 0;
  const row = showing ? Math.floor(frame / columns) : 0;
  return (
    <span
      className="team-explorer-tile-frames"
      data-state={showing ? 'showing' : aspect !== null ? 'ready' : 'idle'}
      aria-hidden="true"
      onPointerEnter={follow}
      onPointerMove={follow}
      onPointerLeave={() => setFrame(null)}
    >
      {showing && (
        <>
          <span
            className="team-explorer-tile-frame"
            data-frame={frame}
            style={
              {
                backgroundImage: `url("${url.replaceAll('"', '%22')}")`,
                backgroundSize: `${columns * 100}% ${rows * 100}%`,
                '--frame-x': columns > 1 ? column / (columns - 1) : 0,
                '--frame-y': rows > 1 ? row / (rows - 1) : 0,
                '--frame-aspect': aspect
              } as CSSProperties
            }
          />
          <span
            className="team-explorer-tile-frames-bar"
            style={{ '--frame-progress': (frame + 1) / frames } as CSSProperties}
          />
        </>
      )}
    </span>
  );
}
