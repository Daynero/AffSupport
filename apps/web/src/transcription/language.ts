import type { Language } from '../i18n';

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi']);

function baseLanguage(code: string): string {
  return code.trim().replaceAll('_', '-').split('-')[0]?.toLowerCase() ?? '';
}

/** Direction belongs to each language column, not to the modal as a whole. */
export function isRtlLanguage(code: string): boolean {
  return RTL_LANGUAGES.has(baseLanguage(code));
}

/**
 * Picks the initial translation target. The Wishly UI language wins when it is
 * different from the source. If both match, a target chosen earlier in this
 * modal is retained; otherwise use the opposite built-in UI language so the
 * split view never attempts a same-language "translation".
 */
export function defaultTranslationTarget(
  sourceLanguage: string,
  uiLanguage: Language,
  lastDistinctTarget: string | null = null
): string {
  const source = baseLanguage(sourceLanguage);
  const previous = lastDistinctTarget?.trim();
  if (source !== uiLanguage) return uiLanguage;
  if (previous && baseLanguage(previous) !== source) return previous;
  return source === 'en' ? 'uk' : 'en';
}

/**
 * Human-readable name for an ISO 639 code, localized to the UI language.
 * Falls back to the uppercased code when Intl.DisplayNames is unavailable or
 * the code is unknown (whisper occasionally emits rarer tags).
 */
export function languageDisplayName(code: string, uiLanguage: Language): string {
  const normalized = code.trim().toLowerCase();
  if (!normalized) return code;
  try {
    const display = new Intl.DisplayNames([uiLanguage, 'en'], { type: 'language' });
    const name = display.of(normalized);
    if (name && name.toLowerCase() !== normalized) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  } catch {
    // Older engines: fall through to the raw code.
  }
  return normalized.toUpperCase();
}
