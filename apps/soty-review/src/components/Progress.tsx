export function Progress({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="soty-progress-wrap">
      <span>
        {label}
        {value === null ? '…' : ` · ${value}%`}
      </span>
      <div
        className={value === null ? 'soty-progress is-indeterminate' : 'soty-progress'}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
      >
        <span style={value === null ? undefined : { width: `${value}%` }} />
      </div>
    </div>
  );
}
