import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { uiClasses, type UiSize } from './types';

/**
 * Choice controls (021, T019).
 *
 * Checkbox, Switch, Slider, SegmentedControl and RadioGroup — including the
 * picto variant, which is this product's own and is specified in
 * `docs/DESIGN.md` down to the pixel: 44×38 plates, `is-selected` (never
 * `is-active`, which does not exist in this system), `is-labeled` for short
 * values like `24` or `1080p`, and `is-single` for a lone toggle, where the
 * container's border disappears so there is not a double outline.
 */

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'type'
> {
  label?: ReactNode;
  size?: Extract<UiSize, 'xs' | 'sm' | 'md'>;
  indeterminate?: boolean;
}

export function Checkbox({
  label,
  size = 'md',
  indeterminate = false,
  className,
  disabled,
  ...props
}: CheckboxProps) {
  return (
    <label className={uiClasses('checkbox', { size, states: { disabled }, className })}>
      <input
        type="checkbox"
        {...props}
        disabled={disabled}
        aria-checked={indeterminate ? 'mixed' : undefined}
        ref={element => {
          if (element) element.indeterminate = indeterminate;
        }}
      />
      <span className="ui-checkbox-mark" aria-hidden="true" />
      {label && <span className="ui-checkbox-label">{label}</span>}
    </label>
  );
}

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  label?: ReactNode;
  size?: Extract<UiSize, 'sm' | 'md'>;
}

export function Switch({ label, size = 'md', className, disabled, ...props }: SwitchProps) {
  return (
    <label className={uiClasses('switch', { size, states: { disabled }, className })}>
      <input type="checkbox" role="switch" {...props} disabled={disabled} />
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-thumb" />
      </span>
      {label && <span className="ui-switch-label">{label}</span>}
    </label>
  );
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>;
  onChange: (value: T) => void;
  /** Names the group for assistive technology. */
  label: string;
  size?: Extract<UiSize, 'xs' | 'sm' | 'md'>;
  disabled?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  disabled = false,
  className
}: SegmentedControlProps<T>) {
  return (
    <div
      className={uiClasses('segmented', { size, states: { disabled }, className })}
      role="radiogroup"
      aria-label={label}
    >
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          disabled={disabled}
          className={option.value === value ? 'is-selected' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  /** The picto variant draws this and puts the label in the tooltip. */
  icon?: ReactNode;
  /** A short value drawn as text on the plate — `24`, `1080p`, `30–40`. */
  short?: ReactNode;
  description?: ReactNode;
  title?: string;
  disabled?: boolean;
  /** A state only this option has — the CRF gem grows while its slider moves. */
  className?: string;
}

export interface RadioGroupProps<T extends string> {
  value: T | null;
  options: ReadonlyArray<RadioOption<T>>;
  onChange: (value: T) => void;
  label: string;
  /**
   * `list` — a column of labelled radios.
   * `cards` — a row of pressable cards (onboarding, upload presets).
   * `pictos` — this product's own: icon plates with the label in a tooltip.
   */
  variant?: 'list' | 'cards' | 'pictos';
  /** A lone picto toggle: the container's border goes, per docs/DESIGN.md. */
  single?: boolean;
  disabled?: boolean;
  className?: string;
  /** Drawn under a picto group: what the current choice means, in words. */
  summary?: ReactNode;
}

export function RadioGroup<T extends string>({
  value,
  options,
  onChange,
  label,
  variant = 'list',
  single = false,
  disabled = false,
  className,
  summary
}: RadioGroupProps<T>) {
  const name = useId();
  if (variant === 'pictos') {
    return (
      <>
        <div
          className={uiClasses('pictos', { states: { single, disabled }, className })}
          role="radiogroup"
          aria-label={label}
        >
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={option.value === value}
              /* The name is the label; the tip may say more than the name
                 does. They were the same field once, which made the longer
                 hint the control's accessible name. */
              aria-label={String(option.label)}
              /* The product draws its own tip off `data-tip` rather than the
                 native one, which appears a second late and cannot be styled;
                 `title` stays for the browsers and tools that read it. */
              data-tip={option.title ?? String(option.label)}
              title={option.title ?? String(option.label)}
              disabled={disabled || option.disabled}
              className={[
                option.value === value ? 'is-selected' : '',
                option.short !== undefined ? 'is-labeled' : '',
                option.className ?? ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onChange(option.value)}
            >
              {option.short !== undefined ? option.short : option.icon}
            </button>
          ))}
        </div>
        {summary && <span className="ui-pictos-summary">{summary}</span>}
      </>
    );
  }

  return (
    <div
      className={uiClasses('radio-group', {
        states: { disabled },
        className: [`ui-radio-group--${variant}`, className].filter(Boolean).join(' ')
      })}
      role="radiogroup"
      aria-label={label}
    >
      {options.map(option => (
        <label
          key={option.value}
          className={`ui-radio${option.value === value ? ' is-selected' : ''}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={disabled || option.disabled}
            onChange={() => onChange(option.value)}
          />
          {option.icon && (
            <span className="ui-radio-icon" aria-hidden="true">
              {option.icon}
            </span>
          )}
          <span className="ui-radio-copy">
            <span className="ui-radio-label">{option.label}</span>
            {option.description && (
              <span className="ui-radio-description">{option.description}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  size?: Extract<UiSize, 'sm' | 'md'>;
  /** A gradient track, as the quality slider uses. */
  gradient?: boolean;
}

export function Slider({ size = 'md', gradient = false, className, ...props }: SliderProps) {
  return (
    <input
      type="range"
      {...props}
      className={uiClasses('slider', { size, states: { gradient }, className })}
    />
  );
}
