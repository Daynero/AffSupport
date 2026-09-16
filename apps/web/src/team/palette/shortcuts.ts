import type { TranslationKey } from '../../i18n';

/**
 * Every keystroke the workspace answers, in one table (024, FR-101).
 *
 * The product had eight of them, bound in four files, and no screen that said
 * so — which makes a shortcut a thing you either already knew or never found.
 * Worse, the one place that *listed* any of them was a tooltip written by
 * hand, so the sheet and the binding could disagree and nobody would know
 * which one was lying.
 *
 * This is the table both read. A binding that is not here is not in the sheet;
 * a line in the sheet that nothing binds is a test failure
 * (`tests/workspace-shortcuts.test.tsx`).
 *
 * ## Writing a chord
 *
 * `mod` is ⌘ on a Mac and Ctrl everywhere else, which is the only difference
 * the product cares about. `format` turns a chord into what a person reads,
 * on the platform they are reading it on.
 */

export interface Shortcut {
  id: string;
  /** The chord, lowercase, with `mod` for ⌘/Ctrl: "mod+k", "/", "delete". */
  keys: string;
  labelKey: TranslationKey;
  /** Which part of the workspace listens for it. */
  scope: 'workspace' | 'explorer' | 'task';
}

export const WORKSPACE_SHORTCUTS: readonly Shortcut[] = [
  { id: 'palette', keys: 'mod+k', labelKey: 'shortcutPalette', scope: 'workspace' },
  { id: 'shortcuts', keys: 'mod+/', labelKey: 'shortcutSheet', scope: 'workspace' },
  { id: 'search', keys: '/', labelKey: 'shortcutSearch', scope: 'explorer' },
  { id: 'copy', keys: 'mod+c', labelKey: 'shortcutCopy', scope: 'explorer' },
  { id: 'cut', keys: 'mod+x', labelKey: 'shortcutCut', scope: 'explorer' },
  { id: 'paste', keys: 'mod+v', labelKey: 'shortcutPaste', scope: 'explorer' },
  { id: 'open', keys: 'enter', labelKey: 'shortcutOpen', scope: 'explorer' },
  { id: 'trash', keys: 'delete', labelKey: 'shortcutTrash', scope: 'explorer' },
  { id: 'clear', keys: 'escape', labelKey: 'shortcutClearSelection', scope: 'explorer' },
  { id: 'move', keys: 'arrows', labelKey: 'shortcutMove', scope: 'explorer' }
];

const BY_ID = new Map(WORKSPACE_SHORTCUTS.map(shortcut => [shortcut.id, shortcut]));

export function shortcutOf(id: string): Shortcut | null {
  return BY_ID.get(id) ?? null;
}

/** ⌘ where the reader's keyboard has one, Ctrl where it does not. */
export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad/iu.test(navigator.platform || navigator.userAgent);
}

const SYMBOL: Record<string, string> = {
  enter: '↵',
  escape: 'Esc',
  delete: '⌫',
  arrows: '↑ ↓ ← →',
  shift: '⇧',
  alt: '⌥'
};

/**
 * The chord as a person reads it.
 *
 * Kept next to the table rather than in the sheet, because the tooltip on a
 * control shows the same thing and the two must not drift — which is the whole
 * reason this file exists.
 */
export function formatShortcut(keys: string, apple = isApple()): string {
  return keys
    .split('+')
    .map(part => {
      if (part === 'mod') return apple ? '⌘' : 'Ctrl';
      if (part === 'alt') return apple ? '⌥' : 'Alt';
      return SYMBOL[part] ?? part.toUpperCase();
    })
    .join(apple ? '' : '+');
}

/** Does this event match the chord? Written once so no call site re-derives it. */
export function matches(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('+');
  const wantsMod = parts.includes('mod');
  const wantsShift = parts.includes('shift');
  const wantsAlt = parts.includes('alt');
  const key = parts[parts.length - 1]!;
  // Coerced, not compared raw: a synthetic event carries only the modifiers it
  // was given, and `undefined !== false` would refuse a chord that matched.
  if (wantsMod !== Boolean(event.metaKey || event.ctrlKey)) return false;
  if (wantsShift !== Boolean(event.shiftKey)) return false;
  if (wantsAlt !== Boolean(event.altKey)) return false;
  return event.key.toLowerCase() === key;
}
