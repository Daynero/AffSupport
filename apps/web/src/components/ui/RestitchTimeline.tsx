/**
 * A re-stitched video drawn as a strip, the way an editor draws a timeline (071).
 *
 * Three clips: the first frame, the video, the final picture. They cannot share one linear
 * scale — a frame is three hundredths of a second, a video seconds to minutes, the final picture
 * thirty to sixty minutes — so the first two are fixed blocks named by their length, an axis
 * break says the scale changes, and the final picture alone is drawn to scale on 0–60 minutes.
 * The final picture's lane is the control: two handles, the shortest and the longest length a
 * video may get. Apart, the band between them is where each video's length is drawn; together,
 * every video gets that one length. Each handle is a slider for the pointer, the keyboard and a
 * screen reader, and the band itself slides the whole range.
 *
 * Presentation only. The caller owns the value, the words and what a clip opens.
 */

import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Dices, Folder, GripVertical, Play } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../icons';
import { FadeImage } from './Feedback';
import {
  dragHandle,
  durationAfterKey,
  slideRange,
  FINAL_MAX_MINUTES,
  FINAL_MIN_MINUTES,
  FINAL_TICKS,
  type FinalDuration,
  type FinalHandle
} from './restitch-timeline-scale';

/** The two ends a person can switch on and off; the video between them is never a choice. */
export type RestitchTimelineEnd = 'start' | 'end';

export interface RestitchTimelineSlot {
  enabled: boolean;
  /** The picture drawn in the clip — a thumbnail or Soty's own; null when only folders are known. */
  image: string | null;
  /** How many pictures of its own the slot draws from; more than one shows the dice. */
  count: number;
  /** Soty's standard picture stands in, because the slot has none of its own. */
  builtin: boolean;
}

export interface RestitchTimelineLabels {
  start: string;
  startLength: string;
  video: string;
  videoLength: string;
  end: string;
  endLength: string;
  off: string;
  builtin: string;
  random: (count: number) => string;
  axisBreak: string;
  /** What the video clip says on hover: that nothing in it changes. */
  videoNote: string;
  /** A switch's tooltip: what pressing it does. */
  toggle: (part: RestitchTimelineEnd, enabled: boolean) => string;
  /** Each handle's name: the shortest and the longest length. */
  sliderLow: string;
  sliderHigh: string;
  valueText: (duration: FinalDuration, handle: FinalHandle) => string;
  unit: string;
}

export interface RestitchTimelineProps {
  start: RestitchTimelineSlot;
  end: RestitchTimelineSlot;
  duration: FinalDuration;
  onDurationChange: (duration: FinalDuration) => void;
  /** Switches an end on or off, right on its clip. */
  onToggle: (part: RestitchTimelineEnd, enabled: boolean) => void;
  /** Read-only: the clips still open their panels, the handle does not move. */
  disabled?: boolean;
  labels: RestitchTimelineLabels;
}

function same(a: FinalDuration, b: FinalDuration): boolean {
  return a.low === b.low && a.high === b.high;
}

/** What a pointer took hold of: one handle, or the band — the whole range, or one exact length. */
type Grip =
  { kind: 'handle'; handle: FinalHandle } | { kind: 'band'; x: number; start: FinalDuration };

function SlotBadge({
  slot,
  labels
}: {
  slot: RestitchTimelineSlot;
  labels: RestitchTimelineLabels;
}) {
  if (slot.builtin) return <span className="restitch-timeline-badge">{labels.builtin}</span>;
  if (slot.count > 1)
    return (
      <span className="restitch-timeline-badge" title={labels.random(slot.count)}>
        <Dices size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {slot.count}
      </span>
    );
  return null;
}

export function RestitchTimeline({
  start,
  end,
  duration,
  onDurationChange,
  onToggle,
  disabled = false,
  labels
}: RestitchTimelineProps) {
  const track = useRef<HTMLDivElement>(null);
  const handles = useRef<Record<FinalHandle, HTMLDivElement | null>>({ low: null, high: null });
  const pointer = useRef<{ id: number; grip: Grip } | null>(null);
  const [dragging, setDragging] = useState(false);
  const { low, high } = duration;
  const movable = end.enabled && !disabled;
  // The value the next event starts from: two keys inside one frame must not both read the
  // value of the render before them.
  const latest = useRef(duration);
  latest.current = duration;

  const change = (next: FinalDuration) => {
    if (same(next, latest.current)) return;
    latest.current = next;
    onDurationChange(next);
  };
  const minuteAt = (clientX: number) => {
    const bounds = track.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return latest.current.high;
    return ((clientX - bounds.left) / bounds.width) * FINAL_MAX_MINUTES;
  };
  const minutesPerPixel = () => {
    const width = track.current?.getBoundingClientRect().width ?? 0;
    return width > 0 ? FINAL_MAX_MINUTES / width : 0;
  };
  const follow = (grip: Grip, clientX: number) => {
    if (grip.kind === 'handle') change(dragHandle(latest.current, grip.handle, minuteAt(clientX)));
    else if (grip.kind === 'band')
      change(slideRange(grip.start, (clientX - grip.x) * minutesPerPixel()));
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    pointer.current = null;
    setDragging(false);
    if (track.current?.hasPointerCapture?.(event.pointerId))
      track.current.releasePointerCapture(event.pointerId);
  };

  const endStyle = {
    '--end-low': low / FINAL_MAX_MINUTES,
    '--end-high': high / FINAL_MAX_MINUTES,
    '--end-image': end.image ? `url("${end.image}")` : 'none'
  } as CSSProperties;

  const handle = (which: FinalHandle) => (
    <div
      key={which}
      ref={node => {
        handles.current[which] = node;
      }}
      className={`restitch-timeline-handle is-${which}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={which === 'low' ? labels.sliderLow : labels.sliderHigh}
      aria-disabled={disabled || undefined}
      aria-valuemin={FINAL_MIN_MINUTES}
      aria-valuemax={FINAL_MAX_MINUTES}
      aria-valuenow={which === 'low' ? low : high}
      aria-valuetext={labels.valueText(duration, which)}
      data-handle={which}
      onKeyDown={event => {
        if (disabled) return;
        const next = durationAfterKey(latest.current, which, event.key);
        if (!next) return;
        event.preventDefault();
        change(next);
      }}
    >
      <GripVertical size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
    </div>
  );

  /* Each end carries its own switch, so what is on and what is off reads off the strip itself
     — both at once, without opening anything. */
  const toggle = (part: RestitchTimelineEnd, enabled: boolean) => (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={part === 'start' ? labels.start : labels.end}
      title={labels.toggle(part, enabled)}
      className="restitch-timeline-toggle"
      disabled={disabled}
      onClick={() => onToggle(part, !enabled)}
    >
      <span className="restitch-timeline-toggle-knob" aria-hidden="true" />
    </button>
  );

  return (
    <div
      className={`restitch-timeline${dragging ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''}${start.enabled ? '' : ' is-start-off'}${end.enabled ? '' : ' is-end-off'}`}
      style={endStyle}
    >
      <div className="restitch-timeline-strip">
        <div className={`restitch-timeline-clip is-start${start.enabled ? '' : ' is-off'}`}>
          {start.enabled &&
            (start.image ? (
              <FadeImage className="restitch-timeline-picture" src={start.image} alt="" />
            ) : (
              <Folder size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ))}
          {start.enabled && <SlotBadge slot={start} labels={labels} />}
          {toggle('start', start.enabled)}
        </div>

        {/* The video is what it is: nothing to set, so nothing to press. */}
        <div className="restitch-timeline-clip is-video" title={labels.videoNote}>
          <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </div>

        <span className="restitch-timeline-break" aria-hidden="true" title={labels.axisBreak} />

        <div
          ref={track}
          className="restitch-timeline-track"
          onPointerDown={event => {
            if (!movable || event.button !== 0) return;
            const target = event.target as Element;
            const held = target.closest<HTMLElement>('[data-handle]')?.dataset.handle as
              FinalHandle | undefined;
            const onBand = Boolean(target.closest('.restitch-timeline-zone'));
            if (target.closest('.restitch-timeline-toggle')) return;
            event.preventDefault();
            const current = latest.current;
            let grip: Grip;
            if (held) grip = { kind: 'handle', handle: held };
            else if (onBand) grip = { kind: 'band', x: event.clientX, start: current };
            else {
              // The lane: an exact length moves there whole; of a range, the nearer handle does.
              const minute = minuteAt(event.clientX);
              if (current.low === current.high) {
                const at = Math.min(
                  FINAL_MAX_MINUTES,
                  Math.max(FINAL_MIN_MINUTES, Math.round(minute))
                );
                change({ low: at, high: at });
                grip = { kind: 'band', x: event.clientX, start: { low: at, high: at } };
              } else {
                grip = {
                  kind: 'handle',
                  handle:
                    Math.abs(minute - current.low) < Math.abs(minute - current.high)
                      ? 'low'
                      : 'high'
                };
                follow(grip, event.clientX);
              }
            }
            pointer.current = { id: event.pointerId, grip };
            setDragging(true);
            track.current?.setPointerCapture?.(event.pointerId);
            if (grip.kind === 'handle') handles.current[grip.handle]?.focus();
          }}
          onPointerMove={event => {
            const active = pointer.current;
            if (active?.id !== event.pointerId) return;
            follow(active.grip, event.clientX);
          }}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
        >
          <div className={`restitch-timeline-clip is-end${end.enabled ? '' : ' is-off'}`}>
            {end.enabled && (
              <>
                <span className="restitch-timeline-film" aria-hidden="true">
                  {!end.image && (
                    <Folder size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                  )}
                </span>
                <SlotBadge slot={end} labels={labels} />
              </>
            )}
            {!end.enabled && <span className="restitch-timeline-off">{labels.off}</span>}
            {toggle('end', end.enabled)}
          </div>
          {end.enabled && low < high && (
            <span className="restitch-timeline-zone" aria-hidden="true" title={labels.endLength} />
          )}
          {end.enabled && (
            <>
              {handle('low')}
              {handle('high')}
              <span
                className="restitch-timeline-bubble"
                aria-hidden="true"
                data-edge={high >= 50 ? 'end' : high <= 10 ? 'start' : undefined}
              >
                {labels.endLength}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="restitch-timeline-captions" aria-hidden="true">
        <span className="restitch-timeline-caption is-start">
          <strong>{labels.start}</strong>
          <span>{start.enabled ? labels.startLength : labels.off}</span>
        </span>
        <span className="restitch-timeline-caption is-video">
          <strong>{labels.video}</strong>
          <span>{labels.videoLength}</span>
        </span>
        <span className="restitch-timeline-caption is-end">
          <strong>{labels.end}</strong>
          <span>{end.enabled ? labels.endLength : labels.off}</span>
        </span>
        {end.enabled && (
          <span className="restitch-timeline-ruler">
            {FINAL_TICKS.map(tick => (
              <span
                key={tick}
                className={tick % 30 === 0 ? 'is-major' : 'is-minor'}
                style={{ '--tick': tick / FINAL_MAX_MINUTES } as CSSProperties}
              >
                {tick === FINAL_MAX_MINUTES ? `${tick} ${labels.unit}` : tick}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
