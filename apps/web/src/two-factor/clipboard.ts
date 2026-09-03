/**
 * Putting a value on the clipboard, from inside the click that asked for it.
 *
 * The one rule this module exists to keep: `writeText` is called synchronously,
 * on the caller's own turn. Browsers gate a clipboard write on user activation,
 * and Safari refuses one issued after an intervening promise — so a value
 * computed asynchronously and then copied lands nowhere while the interface
 * cheerfully says "copied". Everything a row needs before pressing (the seed,
 * and the arithmetic for a code) is therefore already in hand, and this call is
 * the first thing the handler does.
 *
 * The outcome still arrives as a promise, because the *result* of the write is
 * async even when the call is not. It resolves rather than rejects: a refused
 * copy is an ordinary outcome the row has to show, not an exception.
 */
export function copyText(value: string): Promise<boolean> {
  try {
    const written = navigator.clipboard?.writeText(value);
    // No clipboard at all — an insecure origin, or an old browser.
    if (!written) return Promise.resolve(false);
    return written.then(
      () => true,
      () => false
    );
  } catch {
    // Some browsers throw synchronously when the document is not focused.
    return Promise.resolve(false);
  }
}
