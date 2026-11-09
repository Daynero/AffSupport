import { expect, it } from 'vitest';
import { catalogVideoTransferTicket } from '../supabase/functions/drive-ops/catalog-video-transfer-ticket';
const nonce = '47000000-0000-4000-8000-000000000001';
it('reconstructs the same original ticket while separating purposes and secrets', async () => {
  const secret = 'synthetic-server-secret-'.repeat(3),
    source = await catalogVideoTransferTicket(secret, nonce, 'process_input');
  expect(source).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(await catalogVideoTransferTicket(secret, nonce.toUpperCase(), 'process_input')).toBe(
    source
  );
  expect(await catalogVideoTransferTicket(secret, nonce, 'finalize')).not.toBe(source);
  expect(await catalogVideoTransferTicket(secret + 'changed', nonce, 'process_input')).not.toBe(
    source
  );
});
it('rejects malformed nonce and unavailable secret without returning signing material', async () => {
  await expect(catalogVideoTransferTicket('short', nonce, 'finalize')).rejects.toThrow(
    'DRIVE_UNAVAILABLE'
  );
  await expect(
    catalogVideoTransferTicket('s'.repeat(64), 'not-a-uuid', 'finalize')
  ).rejects.toThrow('INVALID_INPUT');
});
