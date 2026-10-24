import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { storeNoticeCapture } from '../scripts/acceptance/mail-capture-store.mjs';
import { writePrivateState } from '../scripts/acceptance/private-state.mjs';
import { scanAcceptanceIsolation } from '../scripts/lib/acceptance-isolation.mjs';
import { removeTemporaryDirectory } from './support/temp-dir';
const namespace = 'acceptance-mail-store';
const id = '36000000-0000-4000-8000-000000000014';
const message = {
  subject: 'Synthetic tariff',
  html: '<p>Тестовий лист</p>',
  text: 'Тестовий лист'
};
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'soty-mail-capture-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryDirectory(root);
});
it('publishes one immutable local capture and replays identical content without a second file', async () => {
  const root = await setup();
  expect(await storeNoticeCapture(namespace, id, 'granted', message, { root })).toMatchObject({
    created: true,
    captured: true,
    delivered: false
  });
  expect(await storeNoticeCapture(namespace, id, 'granted', message, { root })).toMatchObject({
    created: false,
    captured: true,
    delivered: false
  });
  expect(await readdir(path.join(root, namespace))).toEqual([`mail-${id}.json`]);
  const value = JSON.parse(await readFile(path.join(root, namespace, `mail-${id}.json`), 'utf8'));
  expect(value).toMatchObject({ namespace, id, kind: 'granted', message, delivered: false });
});
it('refuses changed content or kind instead of overwriting a prior capture', async () => {
  const root = await setup();
  await storeNoticeCapture(namespace, id, 'granted', message, { root });
  await expect(
    storeNoticeCapture(namespace, id, 'granted', { ...message, text: 'Changed' }, { root })
  ).rejects.toThrow('ACCEPTANCE_MAIL_CAPTURE_CONFLICT');
  await expect(storeNoticeCapture(namespace, id, 'renewed', message, { root })).rejects.toThrow(
    'ACCEPTANCE_MAIL_CAPTURE_CONFLICT'
  );
  await expect(writePrivateState(namespace, `mail-${id}.json`, {}, { root })).rejects.toThrow(
    'ACCEPTANCE_PRIVATE_STATE_INVALID'
  );
  expect(
    JSON.parse(await readFile(path.join(root, namespace, `mail-${id}.json`), 'utf8')).message
  ).toEqual(message);
});
it('rejects oversized records, unsafe names and a linked destination', async () => {
  const root = await setup();
  await expect(
    storeNoticeCapture(namespace, '../escape', 'granted', message, { root })
  ).rejects.toThrow('ACCEPTANCE_MAIL_CAPTURE_INVALID');
  await expect(
    storeNoticeCapture(namespace, id, 'granted', { ...message, text: 'x'.repeat(50000) }, { root })
  ).rejects.toThrow('ACCEPTANCE_MAIL_CAPTURE_INVALID');
  await storeNoticeCapture(namespace, id, 'granted', message, { root });
  const destination = path.join(root, namespace, `mail-${id}.json`);
  await rm(destination);
  const outside = path.join(root, 'sentinel.json');
  await writeFile(outside, 'Unchanged');
  await symlink(outside, destination);
  await expect(storeNoticeCapture(namespace, id, 'granted', message, { root })).rejects.toThrow(
    'ACCEPTANCE_PRIVATE_STATE_UNSAFE'
  );
  expect(await readFile(outside, 'utf8')).toBe('Unchanged');
});
it('rejects the adapter identity if it leaks into deployable functions', async () => {
  const root = await setup();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'supabase/migrations'), { recursive: true });
  await mkdir(path.join(root, 'supabase/functions'), { recursive: true });
  await writeFile(
    path.join(root, 'supabase/functions/accidental.mjs'),
    await readFile('scripts/acceptance/mail-capture-store.mjs')
  );
  expect(scanAcceptanceIsolation({ root }).problems).toContainEqual({
    code: 'ACCEPTANCE_FIXTURE_IN_RELEASE',
    file: 'supabase/functions/accidental.mjs',
    marker: 'mail-capture'
  });
});
