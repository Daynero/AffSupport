import { describe, expect, it, vi } from 'vitest';
import { escapeHtml, sendEmail } from '../supabase/functions/_shared/email.ts';
import {
  handleTariffNoticesRequest,
  type TariffNoticesDeps
} from '../supabase/functions/tariff-notices/handler.ts';
import {
  buildTariffNoticeEmail,
  formatNoticeDate,
  parseTariffNotice,
  TARIFF_NOTICE_KINDS,
  type TariffNoticeKind
} from '../supabase/functions/tariff-notices/templates.ts';

/**
 * Feature 034, T011: the tariff letters worker with the database, Resend and the clock replaced by
 * recording fakes. What must hold: only the worker secret opens it; beta marks every letter
 * skipped and sends nothing; each kind reads right in both languages with every database value
 * escaped; a failed send is finished with a short reason; the counts add up.
 */

const SECRET = 'catalog-sync-secret-0123456789abcdef-xyz';
const NOW = Date.parse('2026-10-11T09:00:00Z');

function row(kind: TariffNoticeKind, overrides: Record<string, unknown> = {}) {
  return {
    id: `10000000-0000-4000-8000-${String(TARIFF_NOTICE_KINDS.indexOf(kind) + 1).padStart(12, '0')}`,
    kind,
    tariffId: '20000000-0000-4000-8000-000000000001',
    teamId: '30000000-0000-4000-8000-000000000001',
    teamName: 'Media <b>buyers</b> & co',
    recipientEmail: 'owner@example.test',
    recipientName: 'Roman <script>alert(1)</script>',
    locale: 'uk',
    planNameUk: 'Лід',
    planNameEn: 'Lead',
    endsOn: '2026-10-14',
    graceUntil: '2026-10-17',
    updaterRunning: false,
    contact: { telegram: 'soty_admin', email: 'admin@example.test' },
    memberName: kind === 'member_nudge' ? 'Olena "<img>"' : null,
    ...overrides
  };
}

function request(secret: string | null = SECRET, method = 'POST') {
  return new Request('http://localhost/functions/v1/tariff-notices', {
    method,
    headers: secret === null ? {} : { 'x-catalog-sync-secret': secret },
    body: method === 'POST' ? '{}' : undefined
  });
}

function deps(rows: unknown[], overrides: Partial<TariffNoticesDeps> = {}) {
  const batches = [rows];
  const finished: Array<[string, boolean, string | null, boolean]> = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const value: TariffNoticesDeps = {
    secret: SECRET,
    environment: 'production',
    siteUrl: 'https://soty.pp.ua',
    sender: { apiKey: 're_test_key_0123456789', from: 'Soty <team@example.test>' },
    claim: vi.fn(async () => batches.shift() ?? []),
    finish: vi.fn(async (id, sent, error, skipped) => {
      finished.push([id, sent, error, skipped]);
      return true;
    }),
    send: vi.fn(async () => ({ state: 'sent' as const, reason: null })),
    now: () => NOW,
    log: (message, detail) => logs.push([message, detail]),
    ...overrides
  };
  return { value, finished, logs };
}

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    value?: { claimed: number; sent: number; skipped: number; failed: number };
    error?: { code: string };
  };
}

describe('tariff-notices access', () => {
  it.each([
    ['missing', null],
    ['wrong', 'catalog-sync-secret-0123456789abcdef-NOPE']
  ])('refuses a %s worker secret without claiming anything', async (_label, secret) => {
    const { value } = deps([row('warn_3d')]);
    const response = await handleTariffNoticesRequest(request(secret), value);
    expect(response.status).toBe(401);
    expect((await body(response)).error?.code).toBe('AUTH_REQUIRED');
    expect(value.claim).not.toHaveBeenCalled();
  });

  it('refuses when the function has no secret configured', async () => {
    const { value } = deps([row('warn_3d')], { secret: undefined });
    const response = await handleTariffNoticesRequest(request(), value);
    expect(response.status).toBe(401);
    expect(value.claim).not.toHaveBeenCalled();
  });

  it('refuses anything but POST', async () => {
    const { value } = deps([]);
    const response = await handleTariffNoticesRequest(request(SECRET, 'GET'), value);
    expect(response.ok).toBe(false);
    expect(value.claim).not.toHaveBeenCalled();
  });

  it('claims nothing outside beta when delivery is not configured', async () => {
    const { value } = deps([row('warn_3d')], { sender: { apiKey: '', from: '' } });
    const response = await handleTariffNoticesRequest(request(), value);
    expect((await body(response)).error?.code).toBe('DELIVERY_UNAVAILABLE');
    expect(value.claim).not.toHaveBeenCalled();
  });
});

describe('tariff-notices delivery', () => {
  it('marks every letter skipped in beta and never sends', async () => {
    const { value, finished } = deps([row('warn_3d'), row('granted')], {
      environment: 'beta',
      sender: { apiKey: '', from: '' }
    });
    const response = await handleTariffNoticesRequest(request(), value);
    expect(await body(response)).toEqual({
      ok: true,
      value: { claimed: 2, sent: 0, skipped: 2, failed: 0 }
    });
    expect(value.send).not.toHaveBeenCalled();
    expect(finished.map(([, sent, error, skipped]) => [sent, error, skipped])).toEqual([
      [false, null, true],
      [false, null, true]
    ]);
  });

  it('sends each claimed letter and finishes it as sent', async () => {
    const { value, finished } = deps([row('warn_1d'), row('renewed', { locale: 'en' })]);
    const response = await handleTariffNoticesRequest(request(), value);
    expect((await body(response)).value).toEqual({ claimed: 2, sent: 2, skipped: 0, failed: 0 });
    expect(value.send).toHaveBeenCalledTimes(2);
    const first = vi.mocked(value.send).mock.calls[0][0];
    expect(first.to).toBe('owner@example.test');
    expect(first.from).toBe('Soty <team@example.test>');
    expect(finished.map(([, sent, error, skipped]) => [sent, error, skipped])).toEqual([
      [true, null, false],
      [true, null, false]
    ]);
    expect(value.claim).toHaveBeenCalledWith(20);
  });

  it('finishes a failed send with its reason and logs no address or key', async () => {
    const { value, finished, logs } = deps([row('grace'), row('blocked')], {
      send: vi
        .fn()
        .mockResolvedValueOnce({ state: 'failed', reason: 'provider_http_503' })
        .mockResolvedValueOnce({ state: 'sent', reason: null })
    });
    const response = await handleTariffNoticesRequest(request(), value);
    expect((await body(response)).value).toEqual({ claimed: 2, sent: 1, skipped: 0, failed: 1 });
    expect(finished[0]).toEqual([row('grace').id, false, 'provider_http_503', false]);
    const logged = JSON.stringify(logs);
    expect(logged).toContain('provider_http_503');
    expect(logged).not.toContain('example.test');
    expect(logged).not.toContain('re_test_key');
  });

  it('fails an unusable row without sending it', async () => {
    const { value, finished } = deps([row('warn_3d', { endsOn: 'soon' })]);
    const response = await handleTariffNoticesRequest(request(), value);
    expect((await body(response)).value).toEqual({ claimed: 1, sent: 0, skipped: 0, failed: 1 });
    expect(value.send).not.toHaveBeenCalled();
    expect(finished[0].slice(1)).toEqual([false, 'invalid_notice', false]);
  });

  it('keeps claiming full batches and stops when the queue hands rows back', async () => {
    const full = Array.from({ length: 20 }, (_, index) =>
      row('warn_3d', { id: `10000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}` })
    );
    const batches = [full, full];
    const { value } = deps([], { claim: vi.fn(async () => batches.shift() ?? []) });
    const response = await handleTariffNoticesRequest(request(), value);
    expect((await body(response)).value?.claimed).toBe(20);
    expect(value.claim).toHaveBeenCalledTimes(2);
  });
});

describe('tariff-notices templates', () => {
  const context = { siteUrl: 'https://soty.pp.ua/some/path?x=1', now: NOW };

  it('writes dates the way people say them', () => {
    expect(formatNoticeDate('2026-10-14', 'uk', NOW)).toBe('14 жовтня');
    expect(formatNoticeDate('2026-10-14', 'en', NOW)).toBe('October 14');
    expect(formatNoticeDate('2027-01-02', 'uk', NOW)).toBe('2 січня 2027 р.');
    // An instant is read as its Kyiv day: 21:30 UTC on the 14th is already the 15th in Kyiv.
    expect(formatNoticeDate('2026-10-14T21:30:00Z', 'uk', NOW)).toBe('15 жовтня');
  });

  const expected: Record<TariffNoticeKind, { uk: string[]; en: string[] }> = {
    warn_3d: {
      uk: ['Тариф «Лід»', 'діє до 14 жовтня включно.', '17 жовтня'],
      en: ['“Lead” plan', 'is active through October 14.', 'October 17']
    },
    warn_1d: {
      uk: ['закінчується завтра, 14 жовтня.'],
      en: ['ends tomorrow, October 14.']
    },
    grace: {
      uk: ['Тариф закінчився.', 'працюватиме до 17 жовтня.'],
      en: ['Your plan has ended.', 'keeps working until October 17.']
    },
    blocked: {
      uk: [
        'Простір призупинено. Тариф закінчився 14 жовтня.',
        'Усе збережено — файли лишаються на вашому Google Диску'
      ],
      en: ['The space is paused. Your plan ended on October 14.', 'Everything is kept']
    },
    granted: {
      uk: ['Простір відкрито до 14 жовтня включно.', 'Увійдіть у Soty з owner@example.test.'],
      en: ['Your space is open through October 14.', 'Sign in to Soty with owner@example.test.']
    },
    renewed: {
      uk: ['продовжено до 14 жовтня включно.'],
      en: ['is extended through October 14.']
    },
    member_nudge: {
      uk: ['просить відновити доступ до простору', 'Простір призупинено'],
      en: ['asks you to restore access to', 'The space is paused']
    }
  };

  for (const kind of TARIFF_NOTICE_KINDS) {
    for (const locale of ['uk', 'en'] as const) {
      it(`renders ${kind} in ${locale} with every value escaped`, () => {
        const notice = parseTariffNotice(row(kind, { locale }));
        expect(notice).not.toBeNull();
        const message = buildTariffNoticeEmail(notice!, context);
        for (const phrase of expected[kind][locale]) expect(message.text).toContain(phrase);
        for (const phrase of expected[kind][locale]) {
          expect(message.html).toContain(escapeHtml(phrase));
        }
        expect(message.html).toContain(`lang="${locale}"`);
        expect(message.html).toContain('href="https://soty.pp.ua/team"');
        expect(message.text).toContain('https://soty.pp.ua/team');
        // No raw markup from the database reaches the letter.
        expect(message.html).not.toMatch(/<script|<b>|<img/);
        expect(message.subject).not.toMatch(/[<>]/);
        expect(message.text).not.toMatch(/[<>]/);
        // Never a count of days.
        expect(`${message.subject} ${message.text}`).not.toMatch(/\b0\s*(днів|days)/);
      });
    }
  }

  it('escapes the space and person names into the HTML part', () => {
    const message = buildTariffNoticeEmail(parseTariffNotice(row('warn_3d'))!, context);
    // Names are flattened to one line of text first, then escaped.
    expect(message.html).toContain('«Media b buyers /b &amp; co»');
    expect(message.html).toContain('Вітаємо, Roman script alert(1) /script!');
  });

  it('offers the administrator by Telegram and mail on letters about extending', () => {
    const message = buildTariffNoticeEmail(parseTariffNotice(row('warn_3d'))!, context);
    expect(message.html).toContain('href="https://t.me/soty_admin"');
    expect(message.html).toContain('href="mailto:admin@example.test?subject=');
    expect(message.text).toContain('Telegram: https://t.me/soty_admin');
    expect(message.text).toContain('Продовжити чи додати місця — написати адміністратору:');
  });

  it('drops a contact that is not a valid login or address', () => {
    const notice = parseTariffNotice(
      row('grace', { contact: { telegram: 'x"><script>', email: 'not an email' } })
    )!;
    expect(notice.contact).toEqual({ telegram: null, email: null });
    const message = buildTariffNoticeEmail(notice, context);
    expect(message.html).not.toContain('t.me');
    expect(message.html).not.toContain('mailto:');
  });

  it('mentions the catalog updater only while it runs', () => {
    const running = buildTariffNoticeEmail(
      parseTariffNotice(row('grace', { updaterRunning: true }))!,
      context
    );
    expect(running.text).toContain('Потім оновлення каталогів зупиниться.');
    const idle = buildTariffNoticeEmail(parseTariffNotice(row('grace'))!, context);
    expect(idle.text).not.toContain('оновлення каталогів');
  });

  it('refuses a site link that is not HTTPS', () => {
    expect(() =>
      buildTariffNoticeEmail(parseTariffNotice(row('renewed'))!, {
        siteUrl: 'http://evil.example',
        now: NOW
      })
    ).toThrow();
  });
});

describe('shared Resend sender', () => {
  const message = { subject: 's', html: '<p>h</p>', text: 't' };
  const input = {
    apiKey: 're_test_key_0123456789',
    from: 'Soty <team@example.test>',
    to: 'owner@example.test',
    message
  };

  it('posts with the bearer key and reports sent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 }));
    await expect(sendEmail(input, fetchImpl)).resolves.toEqual({ state: 'sent', reason: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.authorization).toBe('Bearer re_test_key_0123456789');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reduces every failure to a short reason without the provider body', async () => {
    const http = vi.fn().mockResolvedValue(new Response('{"message":"raw body"}', { status: 422 }));
    await expect(sendEmail(input, http)).resolves.toEqual({
      state: 'failed',
      reason: 'provider_http_422'
    });
    const odd = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(sendEmail(input, odd)).resolves.toEqual({
      state: 'failed',
      reason: 'provider_response'
    });
    const timeout = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('late'), { name: 'TimeoutError' }));
    await expect(sendEmail(input, timeout)).resolves.toEqual({
      state: 'failed',
      reason: 'timeout'
    });
    const network = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(sendEmail(input, network)).resolves.toEqual({
      state: 'failed',
      reason: 'network'
    });
    await expect(sendEmail({ ...input, apiKey: '' }, network)).resolves.toEqual({
      state: 'failed',
      reason: 'not_configured'
    });
  });
});
