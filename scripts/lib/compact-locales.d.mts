import type { Plugin } from 'vite';
export const COMPACT_LOCALE_KEYS_ID: string;
export function compactLocaleSources(
  english: string,
  ukrainian: string
): {
  keys: string;
  en: string;
  uk: string;
};
export function compactLocalesPlugin(): Plugin;
