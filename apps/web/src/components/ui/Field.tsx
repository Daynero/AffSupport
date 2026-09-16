import { ChevronDown, Search, X } from 'lucide-react';
import { ListBox } from '@heroui/react/list-box';
import { ListBoxItem } from '@heroui/react/list-box-item';
import { NumberField } from '@heroui/react/number-field';
import { SearchField as HeroSearchField } from '@heroui/react/search-field';
import { Select as HeroSelect } from '@heroui/react/select';
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react';
import { uiClasses, type UiSize } from './types';

/**
 * Form controls (021 T018/T020, on HeroUI in 024).
 *
 * `Input` and `Textarea` stay a real `<input>` and a real `<textarea>`: a
 * native text field is the best text field there is — it carries the platform's
 * spellcheck, its autofill, its undo stack and its mobile keyboards, and the
 * library wraps one for exactly the same reason. What moved are the controls
 * where the native element is the weak part: a `<select>` that cannot be styled
 * or hold anything but text, a number field with no steppers, and a search box
 * every screen had re-invented with its own clear button.
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

export interface InputNumberProps {
  /** Draws − and + plates beside the field, as the money column does. */
  steppers?: boolean;
  value?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: UiSize;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  stepUpLabel?: string;
  stepDownLabel?: string;
  className?: string;
  id?: string;
  name?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

/**
 * A number, with the arithmetic the browser never did.
 *
 * A native `type="number"` accepts "1e5" and "--3", clamps nothing, and steps
 * by whatever the spinner decides. This one holds the value, clamps it to its
 * bounds, steps by the amount it was given, and takes the arrow keys and
 * PageUp/PageDown as well as the plates.
 */
export function InputNumber({
  steppers = false,
  value,
  defaultValue,
  onChange,
  min,
  max,
  step,
  size = 'md',
  invalid = false,
  disabled,
  placeholder,
  stepUpLabel,
  stepDownLabel,
  className,
  ...props
}: InputNumberProps) {
  return (
    <NumberField
      {...props}
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      minValue={min}
      maxValue={max}
      step={step}
      isDisabled={disabled}
      isInvalid={invalid}
      className={uiClasses('input-number', {
        size,
        states: { invalid, disabled, steppers },
        className
      })}
    >
      <NumberField.Group className="ui-input-number-group">
        {steppers && (
          <NumberField.DecrementButton className="ui-input-step" aria-label={stepDownLabel ?? '−'}>
            −
          </NumberField.DecrementButton>
        )}
        <NumberField.Input placeholder={placeholder} />
        {steppers && (
          <NumberField.IncrementButton className="ui-input-step" aria-label={stepUpLabel ?? '+'}>
            +
          </NumberField.IncrementButton>
        )}
      </NumberField.Group>
    </NumberField>
  );
}

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

export interface SelectProps {
  size?: UiSize;
  invalid?: boolean;
  /** `{ value, label }` pairs; the label is what the reader sees. */
  options: ReadonlyArray<{ value: string; label: ReactNode; title?: string }>;
  /** The "any"/"none" row, when the control may hold nothing. */
  placeholder?: ReactNode;
  value?: string;
  defaultValue?: string;
  /** Told the value, not handed an event to read it from. */
  onChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  name?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

/**
 * A choice from a closed list.
 *
 * No longer a native `<select>`, which could hold only text, could not be
 * styled past its border, and opened the platform's own list in the middle of
 * a dialog. It is a listbox now — typeahead, arrow keys and Home/End included —
 * and it still renders a hidden native select underneath, so a form that posts
 * still posts.
 */
export function Select({
  size = 'md',
  invalid = false,
  options,
  placeholder,
  value,
  defaultValue,
  onChange,
  disabled,
  className,
  ...props
}: SelectProps) {
  const rows =
    placeholder !== undefined ? [{ value: '', label: placeholder }, ...options] : options;
  return (
    <HeroSelect
      {...props}
      selectedKey={value}
      defaultSelectedKey={defaultValue}
      onSelectionChange={key => onChange?.(key === null ? '' : String(key))}
      isDisabled={disabled}
      isInvalid={invalid}
      className={uiClasses('select', { size, states: { invalid, disabled }, className })}
    >
      <HeroSelect.Trigger className="ui-select-trigger">
        {/* RAC hands the value slot a render function so the empty case can say
            the product's own words rather than the library's default. */}
        <HeroSelect.Value className="ui-select-value">
          {({ isPlaceholder, selectedText }) =>
            isPlaceholder ? (placeholder ?? selectedText) : selectedText
          }
        </HeroSelect.Value>
        <span className="ui-select-chevron" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={1.75} />
        </span>
      </HeroSelect.Trigger>
      <HeroSelect.Popover className="ui-select-popover">
        <ListBox className="ui-select-list">
          {rows.map(option => (
            <ListBoxItem key={option.value} id={option.value} className="ui-select-option">
              {option.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}

export interface SearchFieldProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Fired on Enter, for a search that runs on demand rather than as you type. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  size?: UiSize;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

/**
 * One search box.
 *
 * The product had five, each with its own hand-drawn magnifier and its own
 * clear button — and Escape cleared some of them and not others.
 */
export function SearchField({
  size = 'md',
  disabled,
  className,
  onChange,
  onSubmit,
  placeholder,
  ...props
}: SearchFieldProps) {
  return (
    <HeroSearchField
      {...props}
      isDisabled={disabled}
      onChange={onChange}
      onSubmit={onSubmit}
      className={uiClasses('search-field', { size, states: { disabled }, className })}
    >
      <HeroSearchField.Group className="ui-search-field-group">
        <HeroSearchField.SearchIcon
          render={iconProps => <Search {...iconProps} size={16} strokeWidth={1.75} />}
        />
        <HeroSearchField.Input placeholder={placeholder} />
        <HeroSearchField.ClearButton>
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </HeroSearchField.ClearButton>
      </HeroSearchField.Group>
    </HeroSearchField>
  );
}

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
