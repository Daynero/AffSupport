import { useId, useLayoutEffect, useRef } from 'react';

function Wheel({
  label,
  count,
  value,
  onChange
}: {
  label: string;
  count: number;
  value: number;
  onChange(value: number): void;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const observed = useRef<number | null>(null);
  const rowHeight = () =>
    list.current?.querySelector<HTMLElement>('[role="option"]')?.offsetHeight ?? 0;
  useLayoutEffect(() => {
    if (observed.current !== value && list.current) {
      observed.current = value;
      list.current.scrollTop = value * rowHeight();
    }
  }, [value]);
  const choose = (next: number) => {
    next = Math.max(0, Math.min(count - 1, next));
    observed.current = next;
    if (list.current) list.current.scrollTop = next * rowHeight();
    if (next !== value) onChange(next);
  };
  return (
    <div className="ui-time-wheel-column">
      <span className="ui-time-wheel-label" id={id}>
        {label}
      </span>
      <div className="ui-time-wheel-frame">
        <div
          ref={list}
          className="ui-time-wheel-list"
          role="listbox"
          aria-labelledby={id}
          aria-activedescendant={`${id}-${value}`}
          tabIndex={0}
          onScroll={event => {
            const height = rowHeight();
            if (!height) return;
            const next = Math.max(
              0,
              Math.min(count - 1, Math.round(event.currentTarget.scrollTop / height))
            );
            if (next !== observed.current) {
              observed.current = next;
              onChange(next);
            }
          }}
          onKeyDown={event => {
            const next =
              event.key === 'ArrowDown'
                ? value + 1
                : event.key === 'ArrowUp'
                  ? value - 1
                  : event.key === 'PageDown'
                    ? value + 5
                    : event.key === 'PageUp'
                      ? value - 5
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? count - 1
                          : null;
            if (next !== null) {
              event.preventDefault();
              choose(next);
            }
          }}
        >
          {Array.from({ length: count }, (_, number) => (
            <button
              key={number}
              id={`${id}-${number}`}
              type="button"
              role="option"
              aria-selected={value === number}
              tabIndex={-1}
              className="ui-time-wheel-option"
              onClick={() => {
                choose(number);
                list.current?.focus();
              }}
            >
              {String(number).padStart(2, '0')}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A bounded, scrollable 24-hour picker; keeps the same HH:MM wire value as a typed field. */
export function TimeWheel({
  value,
  onChange,
  hoursLabel,
  minutesLabel
}: {
  value: string;
  onChange(value: string): void;
  hoursLabel: string;
  minutesLabel: string;
}) {
  const valid = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  const hour = valid ? Number(valid[1]) : 12;
  const minute = valid ? Number(valid[2]) : 0;
  const change = (h: number, m: number) =>
    onChange(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  return (
    <div className="ui-time-wheel">
      <Wheel label={hoursLabel} count={24} value={hour} onChange={next => change(next, minute)} />
      <span className="ui-time-wheel-separator" aria-hidden="true">
        :
      </span>
      <Wheel label={minutesLabel} count={60} value={minute} onChange={next => change(hour, next)} />
    </div>
  );
}
