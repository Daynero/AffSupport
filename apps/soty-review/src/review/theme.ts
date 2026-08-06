import type { Theme } from './model';

export function preferredTheme(input: unknown, prefersDark: boolean): Theme {
  if (input === 'light' || input === 'dark') return input;
  return prefersDark ? 'dark' : 'light';
}

export function motionAllowed(query: Pick<MediaQueryList, 'matches'>): boolean {
  return !query.matches;
}
