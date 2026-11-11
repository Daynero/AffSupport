import { expect, it } from 'vitest';
import {
  normalizeUtcInstant,
  parseTeamFileOperationResult
} from '../packages/shared/src/team/transport';
import { parseBulkTrashGroups } from '../packages/shared/src/team/bulk-trash';
import { catalogDeleteConfirmKey, translate } from '../apps/web/src/i18n';

/**
 * 1.4.3, beta: «Видалити вибрані» in the catalog manager answered «Сервер
 * відповів несподівано». Two old groups carried a historical receipt whose
 * `observedAt` Postgres had rendered with an offset, the strict `Z` check
 * refused it, and the whole list became INVALID_RESPONSE — which also stopped
 * every new bulk trash, because start reads the list first.
 */
const real = '2026-11-11T13:45:28.311888+00:00';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const receipt = (observedAt: string) => ({
  protocolVersion: 1,
  action: 'trash',
  basis: 'catalog_snapshot',
  observedAt,
  state: 'changed',
  memberCount: 1,
  matchingCount: 0,
  missingCount: 0
});
const group = (n: number, observedAt?: string) => ({
  id: id(n),
  teamId: id(100),
  actorId: id(101),
  items: [
    {
      materialId: id(200 + n),
      idempotencyKey: `key-${n}`,
      state: observedAt ? 'confirmed' : 'queued',
      errorCode: null,
      ...(observedAt ? { historicalReceipt: receipt(observedAt) } : {})
    }
  ]
});

it('accepts the offset string Postgres really sends and rewrites it to UTC Z', () => {
  expect(normalizeUtcInstant(real)).toBe('2026-11-11T13:45:28.311888Z');
  expect(normalizeUtcInstant('2026-11-11T15:45:28.5+02:00')).toBe('2026-11-11T13:45:28.5Z');
  expect(normalizeUtcInstant('2026-11-11T00:30:00-0130')).toBe('2026-11-11T02:00:00Z');
  expect(normalizeUtcInstant('2026-11-11T13:45:28Z')).toBe('2026-11-11T13:45:28Z');
  // A wall time without a zone is not an instant, and nonsense stays refused.
  expect(normalizeUtcInstant('2026-11-11T13:45:28')).toBeNull();
  expect(normalizeUtcInstant('2026-13-11T13:45:28Z')).toBeNull();
  expect(normalizeUtcInstant('2026-11-11T13:45:28+25:00')).toBeNull();
  const parsed = parseTeamFileOperationResult({
    operationId: 'op',
    materialId: id(1),
    state: 'succeeded',
    reused: true,
    historicalReceipt: receipt(real)
  });
  expect(parsed?.historicalReceipt?.observedAt).toBe('2026-11-11T13:45:28.311888Z');
});

it('keeps a readable list when one group is malformed, and normalizes the rest', () => {
  const broken = { ...group(3), items: [{ ...group(3).items[0]!, state: 'done' }] };
  const parsed = parseBulkTrashGroups([group(1, real), group(2), broken, 'junk']);
  expect(parsed?.groups.map(entry => entry.id)).toEqual([id(1), id(2)]);
  expect(parsed?.groups[0]!.items[0]!.historicalReceipt?.observedAt).toBe(
    '2026-11-11T13:45:28.311888Z'
  );
  expect(parsed?.rejected).toEqual([id(3), 'unidentified']);
  expect(parseBulkTrashGroups({})).toBeNull();
});

it('declines the delete confirmation by count', () => {
  const text = (language: 'uk' | 'en', count: number) =>
    translate(language, catalogDeleteConfirmKey(language, count), { count });
  expect(text('uk', 1)).toBe('Перемістити 1 вибраний каталог у кошик Google Drive?');
  expect(text('uk', 4)).toBe('Перемістити 4 вибрані каталоги у кошик Google Drive?');
  expect(text('uk', 5)).toBe('Перемістити 5 вибраних каталогів у кошик Google Drive?');
  expect(text('uk', 21)).toBe('Перемістити 21 вибраний каталог у кошик Google Drive?');
  expect(text('en', 1)).toBe('Move 1 selected catalog to the Google Drive trash?');
  expect(text('en', 4)).toBe('Move 4 selected catalogs to the Google Drive trash?');
});
