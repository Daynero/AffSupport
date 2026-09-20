import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { uiClasses, type UiSize } from './types';

/**
 * Form controls (021, T018, T020).
 *
 * `docs/DESIGN.md` already fixed most of this and the screens drifted from it
 * anyway: the unit belongs *outside* the field's border as muted text, a custom
 * value sits at 72–150px rather than filling its column, and an error appears
 * only after an invalid entry — never on a field somebody has just opened.
 * Those rules are encoded here, so using the component is the same thing as
 * following them (FR-040).
 */

export interface FieldProps {
  label?: ReactNode;
  /** The "?" a label carries when the explanation is longer than its name. */
  hint?: ReactNode;
  /** One line under the control, at caption size, always present when given. */
  help?: ReactNode;
  /**
   * Shown only once the entry is actually wrong. A freshly opened empty field
   * is not an error (docs/DESIGN.md).
   */
  error?: ReactNode;
  required?: boolean;
  size?: UiSize;
  className?: string;
  children?: ReactNode;
  /** Wires label, help and error to the control for assistive technology. */
  htmlFor?: string;
}

export function FormField({
  label,
  hint,
  help,
  error,
  required = false,
  size = 'md',
  className,
  htmlFor,
  children
}: FieldProps) {
  const generated = useId();
  const describedBy = help ? `${generated}-help` : undefined;
  const errorId = error ? `${generated}-error` : undefined;
  return (
    <div
      className={uiClasses('field', {
        size,
        states: { invalid: Boolean(error), required },
        className
      })}
    >
      {label && (
        <label className="ui-field-label" htmlFor={htmlFor}>
          <span>{label}</span>
          {required && (
            <span className="ui-field-required" aria-hidden="true">
              *
            </span>
          )}
          {hint && <span className="ui-field-hint">{hint}</span>}
        </label>
      )}
      <div className="ui-field-control" aria-describedby={describedBy ?? errorId}>
        {children}
      </div>
      {help && !error && (
        <p className="ui-field-help" id={describedBy}>
          {help}
        </p>
      )}
      {error && (
        <p className="ui-field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: UiSize;
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  /**
   * The unit, drawn outside the border as muted text — `мс`, `px`, `fps`,
   * `kbps` (docs/DESIGN.md). Never inside the field.
   */
  suffix?: ReactNode;
  /** `narrow` is the 72–150px inline field; `full` fills its container. */
  width?: 'narrow' | 'full';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    invalid = false,
    leading,
    trailing,
    suffix,
    width = 'full',
    className,
    disabled,
    ...props
  },
  ref
) {
  const field = (
    <span
      className={uiClasses('input', {
        size,
        states: { invalid, disabled, narrow: width === 'narrow' },
        className
      })}
    >
      {leading && (
        <span className="ui-input-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      <input ref={ref} {...props} disabled={disabled} aria-invalid={invalid || undefined} />
      {trailing && <span className="ui-input-trailing">{trailing}</span>}
    </span>
  );
  if (!suffix) return field;
  return (
    <span className="ui-input-with-suffix">
      {field}
      <span className="ui-input-suffix">{suffix}</span>
    </span>
  );
});

export interface InputNumberProps extends Omit<InputProps, 'type'> {
  /** Draws − and + plates beside the field, as the money column does. */
  steppers?: boolean;
  onStep?: (direction: 1 | -1) => void;
  stepUpLabel?: string;
  stepDownLabel?: string;
}

export const InputNumber = forwardRef<HTMLInputElement, InputNumberProps>(function InputNumber(
  { steppers = false, onStep, stepUpLabel, stepDownLabel, className, ...props },
  ref
) {
  if (!steppers) {
    return (
      <Input
        ref={ref}
        type="number"
        inputMode="numeric"
        width="narrow"
        className={className}
        {...props}
      />
    );
  }
  return (
    <span className={uiClasses('input-number', { className })}>
      <button
        type="button"
        className="ui-input-step"
        aria-label={stepDownLabel ?? '−'}
        disabled={props.disabled}
        onClick={() => onStep?.(-1)}
      >
        −
      </button>
      <Input ref={ref} type="number" inputMode="numeric" width="narrow" {...props} />
      <button
        type="button"
        className="ui-input-step"
        aria-label={stepUpLabel ?? '+'}
        disabled={props.disabled}
        onClick={() => onStep?.(1)}
      >
        +
      </button>
    </span>
  );
});

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  size?: Extract<UiSize, 'sm' | 'md'>;
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { size = 'md', invalid = false, className, disabled, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      {...props}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      className={uiClasses('textarea', { size, states: { invalid, disabled }, className })}
    />
  );
});

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: UiSize;
  invalid?: boolean;
  /** `{ value, label }` pairs; the label is what the reader sees. */
  options: ReadonlyArray<{ value: string; label: ReactNode; title?: string }>;
  /** The "any"/"none" row, when the control may hold nothing. */
  placeholder?: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', invalid = false, options, placeholder, className, disabled, ...props },
  ref
) {
  return (
    <span className={uiClasses('select', { size, states: { invalid, disabled }, className })}>
      <select ref={ref} {...props} disabled={disabled} aria-invalid={invalid || undefined}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map(option => (
          <option key={option.value} value={option.value} title={option.title}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="ui-select-chevron" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false">
          <path
            d="m4 6 4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
      </span>
    </span>
  );
});

export interface InputTagsProps {
  values: readonly string[];
  onRemove: (value: string) => void;
  onAdd?: (value: string) => void;
  placeholder?: string;
  removeLabel?: (value: string) => string;
  disabled?: boolean;
  className?: string;
}

/** A text field that collects short values as chips — task tags, metadata tags. */
export function InputTags({
  values,
  onRemove,
  onAdd,
  placeholder,
  removeLabel,
  disabled = false,
  className
}: InputTagsProps) {
  return (
    <div className={uiClasses('input-tags', { states: { disabled }, className })}>
      {values.map(value => (
        <span key={value} className="ui-input-tag">
          {value}
          <button
            type="button"
            className="ui-input-tag-remove"
            aria-label={removeLabel?.(value) ?? `Remove ${value}`}
            disabled={disabled}
            onClick={() => onRemove(value)}
          >
            ×
          </button>
        </span>
      ))}
      {onAdd && (
        <input
          type="text"
          placeholder={placeholder}
          disabled={disabled}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            const target = event.currentTarget;
            const value = target.value.trim();
            if (!value) return;
            event.preventDefault();
            onAdd(value);
            target.value = '';
          }}
        />
      )}
    </div>
  );
}
