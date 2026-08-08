import type { KeyboardEvent } from 'react';

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = options.findIndex(option => option.value === value);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    onChange(options[(index + delta + options.length) % options.length].value);
  };
  return (
    <div className="soty-segmented" role="radiogroup" aria-label={label} onKeyDown={move}>
      {options.map(option => (
        <button
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          key={option.value}
          onClick={() => onChange(option.value)}
          data-demo-action
          data-review-id={`control/${label}/${option.value}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Status({ tone, children }: { tone: string; children: string }) {
  return (
    <span className={`soty-status is-${tone}`}>
      <span className="soty-status-dot" aria-hidden="true">
        ●
      </span>{' '}
      {children}
    </span>
  );
}
