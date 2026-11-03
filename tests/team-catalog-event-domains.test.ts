import { describe, expect, it } from 'vitest';
import { catalogEventDomains } from '../apps/web/src/team/catalogEventDomains';

describe('published catalog event domains', () => {
  it.each(['folder_indexed', 'thumbnail_ready'])(
    '%s updates files and health without waking the updater',
    kind => {
      expect(catalogEventDomains(kind)).toEqual(['catalog', 'storage']);
    }
  );
  it('rereads connection metadata when the root changes without task/member invalidation', () => {
    expect(catalogEventDomains('storage_state')).toEqual(['catalog', 'storage', 'teams']);
  });
  it.each(['upserted', 'tombstoned', 'restored', 'sync_state', 'bulk_trash_changed'])(
    '%s preserves overloaded updater producer compatibility',
    kind => {
      expect(catalogEventDomains(kind)).toEqual(['catalog', 'storage', 'updater']);
    }
  );
  it.each([undefined, null, 'future_server_kind', '__proto__', 42])(
    'keeps unrecognized kind %s conservative',
    kind => {
      expect(catalogEventDomains(kind)).toEqual(['catalog', 'storage', 'updater']);
    }
  );
});
