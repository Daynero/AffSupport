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
