import { TeamFunctionError } from '../_shared/errors.ts';
/** Purpose-separated from native-control/image tickets. Reconstructing this MAC
 * grants nothing unless the exact acknowledged generic transfer row exists. */
export async function catalogVideoTransferTicket(
  secret: string,
  nonce: string,
  purpose: 'process_input' | 'finalize'
) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096)
    throw new TeamFunctionError('DRIVE_UNAVAILABLE');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(nonce) ||
    !['process_input', 'finalize'].includes(purpose)
  )
    throw new TeamFunctionError('INVALID_INPUT');
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
      new TextEncoder().encode(
        'soty:catalog-video-process-transfer:v1:' + purpose + ':' + nonce.toLowerCase()
      )
    )
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
