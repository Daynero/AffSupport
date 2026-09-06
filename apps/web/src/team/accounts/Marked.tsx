/**
 * The part of a line that answered the search, marked.
 *
 * With "keto" typed, the list keeps three rows and says nothing about why any
 * of them stayed — the term may have matched an account's name, an agent's id
 * or a run written weeks ago. Marking the match makes the result explain
 * itself, and costs a span.
 */

import type { ReactNode } from 'react';

export function Marked({ text, term }: { text: string; term: string }) {
  const needle = term.normalize('NFC').trim().toLocaleLowerCase();
  if (needle === '') return <>{text}</>;
  const hay = text.toLocaleLowerCase();
  /*
   * Case folding can change a string's length — Turkish `İ` lowercases to two
   * code units — and every offset below indexes `text` by a position found in
   * `hay`. When the two no longer line up the slices double a character, so
   * the line is left as it is rather than mangled.
   */
  if (hay.length !== text.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (;;) {
    const found = hay.indexOf(needle, at);
    if (found === -1) break;
    if (found > at) parts.push(text.slice(at, found));
    parts.push(
      <mark key={found} className="team-accounts-mark">
        {text.slice(found, found + needle.length)}
      </mark>
    );
    at = found + needle.length;
  }
  // Nothing matched here: the row is on screen for something else it holds.
  if (parts.length === 0) return <>{text}</>;
  parts.push(text.slice(at));
  return <>{parts}</>;
}
