/** Reconstruct idle tickets without storing bearer credentials in Postgres. */
export async function landingTicket(secret: string, grantId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`soty:landing-preview-ticket:v1:${grantId}`)
    )
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export async function landingReuseKey(secret: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`soty:landing-preview-key:v1:${secret}`)
    )
  );
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
