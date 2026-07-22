import type { Language } from '../i18n';

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
