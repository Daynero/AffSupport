export function exactReconcile(expected, observed) {
  if (!observed) return { state: 'provenAbsent' };
  for (const [key, value] of Object.entries(expected)) if (observed[key] !== value) return { state: 'conflicting', key };
  return { state: 'matching' };
}
