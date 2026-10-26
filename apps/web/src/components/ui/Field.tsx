import { ComboBox as HeroComboBox } from '@heroui/react/combo-box';
import { Input as HeroInput } from '@heroui/react/input';
import { ChevronDown, Search, X } from 'lucide-react';
import { ComboBoxStateContext } from 'react-aria-components/ComboBox';
import { ListBox } from '@heroui/react/list-box';
import { ListBoxItem } from '@heroui/react/list-box-item';
import { NumberField } from '@heroui/react/number-field';
import { SearchField as HeroSearchField } from '@heroui/react/search-field';
import { Select as HeroSelect } from '@heroui/react/select';
import {
  forwardRef,
  useId,
  useContext,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react';
import { ICON_SIZE, ICON_STROKE } from '../icons';
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
      /* An empty value is "nothing chosen", not a key called "": React Aria
         reads `null` as the placeholder state, and passing the empty string
         instead left the trigger blank where the word should be. */
      selectedKey={value === '' ? null : value}
      defaultSelectedKey={defaultValue === '' ? null : defaultValue}
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
            <ListBoxItem
              key={option.value}
              id={option.value}
              className="ui-select-option"
              /* The trigger reads the chosen row's text from here. HeroUI's item
                 wraps its children, so React Aria cannot derive it, and every
                 select holding a value showed an empty trigger (024). */
              textValue={
                typeof option.label === 'string' ? option.label : (option.title ?? option.value)
              }
            >
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

/** Open only on an intentional press or input, never on restored dialog focus. */
function SelectMenuInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const state = useContext(ComboBoxStateContext);
  return <HeroInput {...props} onClick={() => state?.open(null, 'manual')} />;
}

/** The searchable closed-choice control in the inventory contract (024). */
export interface SelectMenuOption {
  value: string;
  label: string;
  description?: string;
  /** Additional local search terms; never passed to telemetry. */
  searchText?: string;
}
export function SelectMenu({
  id,
  label,
  value,
  options,
  onChange,
  onCreate,
  placeholder,
  disabled = false,
  createLabel,
  errorLabel,
  size = 'md',
  renderOption,
  emptyLabel,
  noResultsLabel,
  showSearchIcon = false
}: {
  id?: string;
  label: string;
  value: string;
  options: ReadonlyArray<SelectMenuOption>;
  renderOption?: (option: SelectMenuOption, selected: boolean) => ReactNode;
  emptyLabel?: string;
  noResultsLabel?: string;
  showSearchIcon?: boolean;
  onChange: (value: string) => void;
  onCreate?: (value: string) => Promise<string | void>;
  placeholder: string;
  createLabel?: (value: string) => string;
  errorLabel: string;
  disabled?: boolean;
  size?: UiSize;
}) {
  const selectedLabel = options.find(option => option.value === value)?.label ?? '';
  const [query, setQuery] = useState(selectedLabel);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel, value]);
  const filtered =
    query === selectedLabel
      ? options
      : options.filter(option =>
          option.searchText === undefined
            ? option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())
            : query
                .trim()
                .toLocaleLowerCase()
                .split(/\s+/u)
                .every(term =>
                  `${option.label} ${option.searchText}`.toLocaleLowerCase().includes(term)
                )
        );
  const candidate = query.trim();
  const mayCreate = Boolean(
    onCreate &&
    createLabel &&
    candidate &&
    !options.some(option => option.label.toLocaleLowerCase() === candidate.toLocaleLowerCase())
  );
  return (
    <div>
      <HeroComboBox
        aria-label={label}
        selectedKey={value || null}
        // A dialog restoring focus must not reopen the completed selection.
        menuTrigger="input"
        inputValue={query}
        // Filtering already includes metadata; React Aria must not re-filter by label alone.
        defaultFilter={() => true}
        isDisabled={disabled || creating}
        allowsCustomValue={false}
        allowsEmptyCollection
        onInputChange={next => {
          setQuery(next);
          setFailed(false);
        }}
        onBlur={() => {
          if (!creatingRef.current) setQuery(selectedLabel);
        }}
        onSelectionChange={key => {
          if (key === null) return;
          if (key === '__create__' && onCreate && mayCreate) {
            creatingRef.current = true;
            setCreating(true);
            setFailed(false);
            void onCreate(candidate)
              .then(createdValue => {
                if (typeof createdValue === 'string' && mounted.current) {
                  setQuery(candidate);
                  onChange(createdValue);
                }
              })
              .catch(() => {
                if (mounted.current) setFailed(true);
              })
              .finally(() => {
                creatingRef.current = false;
                if (mounted.current) setCreating(false);
              });
          } else {
            const option = options.find(option => option.value === String(key));
            if (option) {
              setQuery(option.label);
              onChange(option.value);
            }
          }
        }}
        className={uiClasses('select', { size, states: { disabled: disabled || creating } })}
      >
        <HeroComboBox.InputGroup className="ui-select-trigger">
          {showSearchIcon && (
            <Search
              size={ICON_SIZE}
              strokeWidth={ICON_STROKE}
              aria-hidden="true"
              className="shrink-0 text-muted"
            />
          )}
          <SelectMenuInput
            id={id}
            className="ui-select-value"
            placeholder={placeholder}
            onFocus={event => {
              if (showSearchIcon) event.currentTarget.select();
            }}
          />
          <HeroComboBox.Trigger aria-label={label}>
            <ChevronDown size={16} strokeWidth={1.75} />
          </HeroComboBox.Trigger>
        </HeroComboBox.InputGroup>
        <HeroComboBox.Popover className="ui-select-popover">
          <ListBox
            className="ui-select-list"
            renderEmptyState={
              emptyLabel || noResultsLabel
                ? () => (
                    <p role="status" className="m-0 px-3 py-2 text-caption text-muted">
                      {options.length ? noResultsLabel : emptyLabel}
                    </p>
                  )
                : undefined
            }
          >
            {filtered.map(option => (
              <ListBoxItem
                key={option.value}
                id={option.value}
                className="ui-select-option"
                textValue={option.label}
                aria-label={
                  option.description ? `${option.label}, ${option.description}` : undefined
                }
              >
                {renderOption ? renderOption(option, option.value === value) : option.label}
              </ListBoxItem>
            ))}
            {mayCreate && (
              <ListBoxItem
                id="__create__"
                className="ui-select-option"
                textValue={createLabel!(candidate)}
              >
                {createLabel!(candidate)}
              </ListBoxItem>
            )}
          </ListBox>
        </HeroComboBox.Popover>
      </HeroComboBox>
      {failed && (
        <p role="alert" className="text-error-text">
          {errorLabel}
        </p>
      )}
    </div>
  );
}
