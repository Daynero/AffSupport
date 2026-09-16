import { Checkbox as HeroCheckbox } from '@heroui/react/checkbox';
import { Slider as HeroSlider } from '@heroui/react/slider';
import { Switch as HeroSwitch } from '@heroui/react/switch';
import { ToggleButton } from '@heroui/react/toggle-button';
import { ToggleButtonGroup } from '@heroui/react/toggle-button-group';
import { useId, useRef, type ReactNode } from 'react';
import { heroSize, uiClasses, useNativeAttributes, type UiSize } from './types';

/**
 * Choice controls (021 T019, rebuilt on HeroUI in 024).
 *
 * Checkbox, Switch, Slider, SegmentedControl and RadioGroup — including the
 * picto variant, which is this product's own and is specified in
 * `docs/DESIGN.md` down to the pixel: 44×38 plates, `is-selected` (never
 * `is-active`, which does not exist in this system), `is-labeled` for short
 * values like `24` or `1080p`, and `is-single` for a lone toggle, where the
 * container's border disappears so there is not a double outline.
 *
 * ## What the library brought
 *
 * Two of these were a row of `<button role="radio">` with no arrow keys. A
 * radio group that cannot be driven by the arrow keys is a radio group in
 * appearance only, and the picto group — this product's signature control, on
 * the compressor's main screen — was one of them. Both are `ToggleButtonGroup`
 * now, which is the same markup with the keyboard included.
 *
 * `indeterminate` stops being a poke into the DOM through a ref and becomes
 * what it always was: a piece of state the control is told about.
 *
 * ## What the product kept
 *
 * The classes, and therefore the appearance. `components.css` still draws every
 * one of these, from the `soty` layer above the library.
 */

export interface CheckboxProps {
  label?: ReactNode;
  size?: Extract<UiSize, 'xs' | 'sm' | 'md'>;
  checked?: boolean;
  defaultChecked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  /**
   * Told whether it is now checked — not handed a DOM event to read it from.
   *
   * The second argument carries the one thing a caller legitimately read off
   * that event: whether Shift was down, which is how a list does range
   * selection. React Aria's own `onChange` gives the value and nothing else, so
   * the modifier is captured on the way in rather than lost.
   */
  onChange?: (checked: boolean, modifiers: { shiftKey: boolean }) => void;
  className?: string;
  name?: string;
  value?: string;
  id?: string;
  autoFocus?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

export function Checkbox({
  label,
  size = 'md',
  checked,
  defaultChecked,
  indeterminate = false,
  disabled,
  onChange,
  className,
  ...props
}: CheckboxProps) {
  // Range selection is a shift-click, so the pointer is the only place the
  // modifier has to be caught.
  const shiftKey = useRef(false);
  return (
    <HeroCheckbox
      {...props}
      isSelected={checked}
      defaultSelected={defaultChecked}
      isIndeterminate={indeterminate}
      isDisabled={disabled}
      onMouseDownCapture={event => {
        shiftKey.current = event.shiftKey;
      }}
      onChange={next => onChange?.(next, { shiftKey: shiftKey.current })}
      className={uiClasses('checkbox', { size, states: { disabled }, className })}
    >
      <HeroCheckbox.Control className="ui-checkbox-mark">
        <HeroCheckbox.Indicator />
      </HeroCheckbox.Control>
      {label && <HeroCheckbox.Content className="ui-checkbox-label">{label}</HeroCheckbox.Content>}
    </HeroCheckbox>
  );
}

export interface SwitchProps {
  label?: ReactNode;
  size?: Extract<UiSize, 'sm' | 'md'>;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  className?: string;
  name?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

export function Switch({
  label,
  size = 'md',
  checked,
  defaultChecked,
  disabled,
  onChange,
  className,
  ...props
}: SwitchProps) {
  return (
    <HeroSwitch
      {...props}
      isSelected={checked}
      defaultSelected={defaultChecked}
      isDisabled={disabled}
      onChange={onChange}
      className={uiClasses('switch', { size, states: { disabled }, className })}
    >
      <HeroSwitch.Control className="ui-switch-track">
        <HeroSwitch.Thumb className="ui-switch-thumb" />
      </HeroSwitch.Control>
      {label && <HeroSwitch.Content className="ui-switch-label">{label}</HeroSwitch.Content>}
    </HeroSwitch>
  );
}

/**
 * A toggle button that keeps its tooltip.
 *
 * React Aria filters `title` off the DOM props it forwards, and in a picto
 * group the tooltip is not decoration — it is the only place the option's name
 * is written (docs/DESIGN.md: the plate carries an icon, the words live in the
 * tip). So it goes on the node.
 */
function TitledToggleButton({
  title,
  children,
  ...props
}: Omit<Parameters<typeof ToggleButton>[0], 'title'> & { title?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useNativeAttributes(ref, { title });
  return (
    <ToggleButton {...props} ref={ref}>
      {children}
    </ToggleButton>
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
    <ToggleButtonGroup
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={keys => {
        const [first] = [...keys];
        if (first !== undefined) onChange(String(first) as T);
      }}
      isDisabled={disabled}
      size={heroSize(size)}
      aria-label={label}
      className={uiClasses('segmented', { size, states: { disabled }, className })}
    >
      {options.map(option => (
        <TitledToggleButton
          key={option.value}
          id={option.value}
          title={option.title}
          className={option.value === value ? 'is-selected' : undefined}
        >
          {option.label}
        </TitledToggleButton>
      ))}
    </ToggleButtonGroup>
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
        <ToggleButtonGroup
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={value === null ? [] : [value]}
          onSelectionChange={keys => {
            const [first] = [...keys];
            if (first !== undefined) onChange(String(first) as T);
          }}
          isDisabled={disabled}
          aria-label={label}
          className={uiClasses('pictos', { states: { single, disabled }, className })}
        >
          {options.map(option => (
            <TitledToggleButton
              key={option.value}
              id={option.value}
              isDisabled={option.disabled}
              isIconOnly={option.short === undefined}
              /* The name is the label; the tip may say more than the name does.
                 They were the same field once, which made the longer hint the
                 control's accessible name. */
              aria-label={String(option.label)}
              title={option.title ?? String(option.label)}
              className={[
                option.value === value ? 'is-selected' : '',
                option.short !== undefined ? 'is-labeled' : '',
                option.className ?? ''
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {option.short !== undefined ? option.short : option.icon}
            </TitledToggleButton>
          ))}
        </ToggleButtonGroup>
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

export interface SliderProps {
  size?: Extract<UiSize, 'sm' | 'md'>;
  /** A gradient track, as the quality slider uses. */
  gradient?: boolean;
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange?: (value: number) => void;
  /** Fired once the drag settles — the expensive half of a live preview. */
  onChangeEnd?: (value: number) => void;
  /**
   * Extra keys on the thumb, for a control whose step is not its keyboard step
   * — the transcript's scrubber drags by hundredths and seeks by seconds.
   *
   * Handled before the library's own keyboard, so a handler that calls
   * `stopPropagation` replaces the default movement rather than adding to it.
   * Both running is how three arrow presses became ten seconds instead of
   * fifteen.
   */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

export function Slider({
  size = 'md',
  gradient = false,
  value,
  defaultValue,
  min,
  max,
  step,
  disabled,
  onChange,
  onChangeEnd,
  onKeyDown,
  className,
  ...props
}: SliderProps) {
  const slider = (
    <HeroSlider
      {...props}
      value={value}
      defaultValue={defaultValue}
      minValue={min}
      maxValue={max}
      step={step}
      isDisabled={disabled}
      onChange={next => onChange?.(typeof next === 'number' ? next : next[0])}
      onChangeEnd={next => onChangeEnd?.(typeof next === 'number' ? next : next[0])}
      className={uiClasses('slider', { size, states: { gradient, disabled }, className })}
    >
      <HeroSlider.Track className="ui-slider-track">
        <HeroSlider.Fill className="ui-slider-fill" />
        <HeroSlider.Thumb className="ui-slider-thumb" />
      </HeroSlider.Track>
    </HeroSlider>
  );

  if (!onKeyDown) return slider;

  /*
   * One wrapper, and only for the control that needs it.
   *
   * React Aria forwards a known list of props and drops the rest, so a capture
   * handler cannot be put on the slider, its track or its thumb. It has to sit
   * above them — which is the only way a control whose keyboard step is not its
   * drag step can replace the library's movement instead of adding to it.
   */
  return (
    <span className="ui-slider-keys" onKeyDownCapture={onKeyDown}>
      {slider}
    </span>
  );
}
