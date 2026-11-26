// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { catalogCodeMessage, catalogFixActionFor } from '../apps/web/src/team/catalogFixActions';
import { translate } from '../apps/web/src/i18n';

// Beta 2026-11-26: a creation stopped on the picture pool's readiness had no sentence of its own.
it('reads an unconfirmed picture pool as a creation to continue, with the caller’s retry', () => {
  for (const code of ['GLOBAL_IMAGE_READINESS_UNKNOWN', 'GLOBAL_IMAGE_POOL_UNAVAILABLE']) {
    expect(catalogFixActionFor(code)).toBe('retry');
    expect(catalogCodeMessage(code, key => translate('uk', key))).toBe(
      'Картинки для каталогу зараз не підтверджено, тому каталог не зібрано. Відео збережено — продовжте створення за кілька хвилин.'
    );
    expect(catalogCodeMessage(code, key => translate('en', key))).toContain(
      'continue the creation in a few minutes'
    );
  }
});
