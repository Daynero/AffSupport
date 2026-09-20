import { useLayoutEffect, type CSSProperties, type RefObject } from 'react';

/**
 * The vocabulary every component in the inventory speaks (021).
 *
 * Modelled on Nuxt UI's prop shape — `color` × `variant` × `size` on anything
 * that can take them — because the product's problem was never a missing
 * control, it was seven names for the same one. These unions are what makes a
 * wrong combination a type error rather than a screen nobody compares.
 */

/** What a control means, never what colour it is. */
export const UI_COLORS = [
  'primary',
  'secondary',
  'success',
  'info',
  'warning',
  'error',
  'neutral'
] as const;
export type UiColor = (typeof UI_COLORS)[number];

/** How loudly it says it. */
export const UI_VARIANTS = ['solid', 'outline', 'soft', 'subtle', 'ghost', 'link'] as const;
export type UiVariant = (typeof UI_VARIANTS)[number];

/** How much room it takes. `md` is the product's long-standing 38px control. */
export const UI_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
export type UiSize = (typeof UI_SIZES)[number];

/**
 * The classes a component composes from its props.
 *
 * One place, so every component spells the modifiers the same way and the
 * stylesheet has one naming rule to answer to: `ui-<component>`,
 * `ui-<component>--<variant>`, `ui-<component>--<size>`, `is-<state>`.
 */
export function uiClasses(
  component: string,
  options: {
    color?: UiColor;
    variant?: UiVariant;
    size?: UiSize;
    states?: Partial<Record<string, boolean | undefined>>;
    className?: string;
  }
): string {
  const parts = [`ui-${component}`];
  if (options.variant) parts.push(`ui-${component}--${options.variant}`);
  if (options.size) parts.push(`ui-${component}--${options.size}`);
  if (options.color) parts.push(`ui-color-${options.color}`);
  for (const [state, on] of Object.entries(options.states ?? {})) {
    if (on) parts.push(`is-${state}`);
  }
  if (options.className) parts.push(options.className);
  return parts.join(' ');
}

/**
 * A fill that is scaled rather than resized (021, T140).
 *
 * Every bar in this product used to grow by animating `width`, which re-lays
 * out its row on every frame — invisible on one bar, plainly visible on a
 * queue of forty. The element stays full width and carries `scaleX()` off this
 * custom property instead, which the compositor can do on its own.
 *
 * Takes a percentage (0–100) because that is what every caller already has.
 */
export function fillRatio(percent: number): CSSProperties {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return { '--fill-ratio': clamped / 100 } as CSSProperties;
}

/**
 * Soty's vocabulary, translated into the library's (024).
 *
 * HeroUI speaks a narrower language than this product: seven button variants
 * against this product's six-times-seven, and three sizes against five. The
 * translation is lossy on purpose and it does not matter, because the library's
 * classes are not what decides the appearance — `components.css` is, from the
 * `soty` layer above it. What this buys is a sensible fallback: a component the
 * inventory has not styled yet still arrives looking like the rest of the
 * product rather than looking unstyled.
 *
 * One place, so the mapping cannot drift between components.
 */
export type HeroVariant =
  'primary' | 'secondary' | 'tertiary' | 'ghost' | 'outline' | 'danger' | 'danger-soft';

export function heroVariant(variant: UiVariant, color: UiColor): HeroVariant {
  const destructive = color === 'error';
  switch (variant) {
    case 'solid':
      return destructive ? 'danger' : 'primary';
    case 'outline':
      return 'outline';
    case 'soft':
      return destructive ? 'danger-soft' : 'secondary';
    case 'subtle':
      return 'tertiary';
    case 'ghost':
    case 'link':
      return 'ghost';
  }
}

/** Five rungs onto three. The middle one is this product's 38px control. */
export function heroSize(size: UiSize): 'sm' | 'md' | 'lg' {
  if (size === 'xs' || size === 'sm') return 'sm';
  if (size === 'lg' || size === 'xl') return 'lg';
  return 'md';
}

/**
 * Attributes put back on an element React Aria will not carry them to.
 *
 * React Aria forwards a known list of props and drops the rest, and two of the
 * ones it drops matter to this product:
 *
 * - `title`, which is where the words live for every control whose label is an
 *   icon (docs/DESIGN.md: "слова живуть у тултіпах"). Two hundred controls
 *   losing their label quietly is not an acceptable side effect of a swap.
 * - `aria-busy`, which is how a control that is working says so to a reader who
 *   cannot see the spinner. The library writes a data attribute for the
 *   stylesheet and stops there.
 *
 * Setting them on the node is deliberately the small fix rather than the right
 * one. The right one for `title` is replacing every native tooltip with the
 * inventory's own `Tooltip`, which is keyboard-reachable and styled — a design
 * pass with its own task, not something to do accidentally while changing what
 * a button is made of.
 */
export function useNativeAttributes(
  ref: RefObject<HTMLElement | null>,
  attributes: Record<string, string | undefined>
) {
  /*
   * The value rather than the object, so a caller may build it inline without
   * re-running this on every render.
   *
   * As a list of pairs, not as an object: `JSON.stringify` drops a key whose
   * value is `undefined`, and a dropped key is a key this never removes — so a
   * button that stopped working would have gone on saying `aria-busy` forever.
   */
  const serialized = JSON.stringify(
    Object.entries(attributes).map(([name, value]) => [name, value ?? null])
  );
  // Before paint, not after: a tooltip or a busy state that arrives a frame
  // late is a frame in which the control is unlabelled or silently working.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    for (const [name, value] of JSON.parse(serialized) as Array<[string, string | null]>) {
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    }
  }, [ref, serialized]);
}
