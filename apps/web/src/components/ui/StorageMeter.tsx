import { useId, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../icons';
import { Tooltip } from './Feedback';

/**
 * The scale of a space's storage (057, US9, FR-046): one bar, the space's categories as
 * segments in the order the ledger counts them, the bytes promised to work under way hatched
 * after them, the rest free.
 *
 * Colour is never the only way to tell a segment: every one has its name and size in the
 * legend beneath, a gap of the track between neighbours, and a hint with name, size and share.
 * The legend is the control — one tab stop, arrows between its entries, Enter to open the
 * category — so the same scale works by keyboard, by mouse over the bar, and by thumb on a
 * phone, where `compact` gives it a two-column legend and a thinner bar.
 *
 * The component knows nothing of bytes: the screen says how to write a size and a share, and
 * what the words are (locales). Widths are a share of the capacity; a change re-lays the bar
 * at once rather than animating a width, and the first draw lifts the fill in with a transform.
 */

export type StorageMeterCategory =
  'materials' | 'catalogs' | 'process' | 'attachments' | 'versions' | 'trash';

export interface StorageMeterSegment {
  category: StorageMeterCategory;
  label: string;
  bytes: number;
}

export type StorageMeterLevel = 'ok' | 'warning' | 'critical' | 'full';

export interface StorageMeterLabels {
  /** The scale's accessible name: «Пам'ять простору». */
  name: string;
  /** «Зайнято 4,2 ГБ з 15 ГБ». */
  summary: string;
  reserved: string;
  free: string;
  /** Said beside the summary from 80 %; absent at `ok`. */
  level?: string;
}

export interface StorageMeterProps {
  segments: readonly StorageMeterSegment[];
  reservedBytes: number;
  capacityBytes: number;
  labels: StorageMeterLabels;
  formatBytes: (bytes: number) => string;
  /** A share of the capacity, 0…1, as words («8 %»). */
  formatShare: (share: number) => string;
  level?: StorageMeterLevel;
  /** The phone's form: thinner bar, two-column legend. */
  compact?: boolean;
  /** The category whose list is open: its legend entry says so. */
  selected?: StorageMeterCategory | null;
  /** A category was chosen (its list opens); absent, the scale only shows. */
  onSelect?: (category: StorageMeterCategory) => void;
  className?: string;
}

interface Entry {
  key: StorageMeterCategory | 'reserved' | 'free';
  label: string;
  bytes: number;
  share: number;
}

const clampShare = (value: number) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function StorageMeter({
  segments,
  reservedBytes,
  capacityBytes,
  labels,
  formatBytes,
  formatShare,
  level = 'ok',
  compact = false,
  selected = null,
  onSelect,
  className
}: StorageMeterProps) {
  const id = useId();
  const legend = useRef<HTMLUListElement>(null);
  const capacity = Math.max(0, capacityBytes);
  const share = (bytes: number) => (capacity > 0 ? clampShare(bytes / capacity) : 0);
  const used = segments.reduce((sum, segment) => sum + Math.max(0, segment.bytes), 0);
  const free = Math.max(0, capacity - used - Math.max(0, reservedBytes));

  const filled: Entry[] = [
    ...segments
      .filter(segment => segment.bytes > 0)
      .map(segment => ({
        key: segment.category,
        label: segment.label,
        bytes: segment.bytes,
        share: share(segment.bytes)
      })),
    ...(reservedBytes > 0
      ? [
          {
            key: 'reserved' as const,
            label: labels.reserved,
            bytes: reservedBytes,
            share: share(reservedBytes)
          }
        ]
      : [])
  ];
  const entries: Entry[] = [
    ...filled,
    { key: 'free', label: labels.free, bytes: free, share: share(free) }
  ];
  const hint = (entry: Entry) =>
    `${entry.label} · ${formatBytes(entry.bytes)} · ${formatShare(entry.share)}`;
  const choosable = (entry: Entry): entry is Entry & { key: StorageMeterCategory } =>
    entry.key !== 'reserved' && entry.key !== 'free';

  // One tab stop for the legend; the arrows walk it (a toolbar's grammar).
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = Array.from(
      legend.current?.querySelectorAll<HTMLButtonElement>('button[data-entry]') ?? []
    );
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (at + 1) % buttons.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (at - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    for (const [index, button] of buttons.entries()) button.tabIndex = index === next ? 0 : -1;
    buttons[next]?.focus();
  };

  const usedShare = share(used + Math.max(0, reservedBytes));
  const firstChoosable = onSelect ? entries.findIndex(choosable) : -1;
  return (
    <div
      className={`ui-storage-meter${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
      data-level={level}
    >
      <div className="ui-storage-meter-heading">
        <strong id={`${id}-summary`}>{labels.summary}</strong>
        {level !== 'ok' && labels.level && (
          <span className="ui-storage-meter-level" role="status">
            {level === 'warning' ? (
              <TriangleAlert size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <CircleAlert size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            )}
            {labels.level}
          </span>
        )}
      </div>
      <div
        className="visually-hidden"
        role="meter"
        aria-label={labels.name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(usedShare * 100)}
        aria-valuetext={labels.summary}
      />
      {/* The bar is a picture of the legend: pointed at, it names a segment; pressed, it opens
          it. The keyboard and screen readers take the legend, which says the same in words. */}
      <div className="ui-storage-meter-track" aria-hidden="true">
        {filled.map(entry => (
          <span
            key={entry.key}
            className={`ui-storage-meter-segment${entry.key === 'reserved' ? ' is-reserved' : ''}`}
            data-category={entry.key}
            title={hint(entry)}
            style={{ '--storage-share': entry.share } as CSSProperties}
            onClick={choosable(entry) && onSelect ? () => onSelect(entry.key) : undefined}
          />
        ))}
      </div>
      <ul
        ref={legend}
        className="ui-storage-meter-legend"
        aria-label={labels.name}
        aria-describedby={`${id}-summary`}
        onKeyDown={onKeyDown}
      >
        {entries.map((entry, index) => {
          const body = (
            <>
              <span
                className={`ui-storage-meter-swatch${entry.key === 'reserved' ? ' is-reserved' : ''}`}
                data-category={entry.key}
                aria-hidden="true"
              />
              <span className="ui-storage-meter-name">{entry.label}</span>
              <span className="ui-storage-meter-value">{formatBytes(entry.bytes)}</span>
            </>
          );
          if (!onSelect || !choosable(entry))
            return (
              <li key={entry.key} className="ui-storage-meter-entry" data-category={entry.key}>
                <span className="ui-storage-meter-item" aria-label={hint(entry)}>
                  {body}
                </span>
              </li>
            );
          return (
            <li key={entry.key} className="ui-storage-meter-entry" data-category={entry.key}>
              <Tooltip label={hint(entry)} asChild>
                <button
                  type="button"
                  data-entry
                  className={`ui-storage-meter-item${selected === entry.key ? ' is-selected' : ''}`}
                  aria-label={hint(entry)}
                  aria-pressed={selected === entry.key}
                  tabIndex={index === firstChoosable ? 0 : -1}
                  onClick={() => onSelect(entry.key)}
                >
                  {body}
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
