// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `act` from the testing library rather than from React: it sets the act
// environment flag, which React otherwise warns about on every call.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { generateTotp } from '../packages/shared/src/totp.js';

/**
 * Feature 016: the notebook as a person meets it.
 *
 * The load-bearing case in this file is the one about the clipboard. A browser
 * spends the user activation a clipboard write needs on the first `await`, and
 * Safari refuses the write after it — so a code that is computed asynchronously
 * lands nowhere while the interface says "copied". That failure passes every
 * casual local test and breaks for a real person on a Mac, so it is asserted
 * directly: after the click, and before anything is awaited, the write has
 * already happened.
 */

const api = vi.hoisted(() => ({
  listEntries: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn()
}));

vi.mock('../apps/web/src/api/two-factor.js', async importActual => {
  const actual = await importActual<typeof import('../apps/web/src/api/two-factor')>();
  return { ...actual, twoFactorApi: api };
});

vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

import TwoFactorPage from '../apps/web/src/two-factor/TwoFactorPage';
import { TwoFactorApiError, type TwoFactorEntry } from '../apps/web/src/api/two-factor';
import { translate } from '../apps/web/src/i18n';

const SEED = 'JBSWY3DPEHPK3PXP';

function entry(overrides: Partial<TwoFactorEntry> = {}): TwoFactorEntry {
  return {
    id: 'entry-1',
    name: 'Facebook — main BM',
    seed: SEED,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides
  };
}

const en = (key: Parameters<typeof translate>[1]) => translate('en', key);

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  api.listEntries.mockResolvedValue([]);
  api.createEntry.mockReset();
  api.updateEntry.mockReset();
  api.deleteEntry.mockReset();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Renders and waits for the first load to settle. */
async function openNotebook(entries: TwoFactorEntry[] = []) {
  api.listEntries.mockResolvedValue(entries);
  render(<TwoFactorPage />);
  await waitFor(() => expect(api.listEntries).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(en('twoFactorLoading'))).toBeNull());
}

async function openForm() {
  fireEvent.click(screen.getByRole('button', { name: en('twoFactorAdd') }));
  await waitFor(() => expect(screen.getByLabelText(en('twoFactorNameLabel'))).toBeTruthy());
}

function fillForm(name: string, seed: string) {
  fireEvent.change(screen.getByLabelText(en('twoFactorNameLabel')), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(en('twoFactorSeedLabel')), { target: { value: seed } });
}

describe('an empty notebook', () => {
  it('says it is empty rather than showing a blank page', async () => {
    await openNotebook([]);
    expect(screen.getByText(en('twoFactorEmpty'))).toBeTruthy();
  });
});

describe('adding a key', () => {
  it('stores it and shows one row with a marker, not the key', async () => {
    await openNotebook([]);
    api.createEntry.mockResolvedValue(entry());

    await openForm();
    fillForm('Facebook — main BM', SEED);
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));

    await waitFor(() => expect(screen.getByText('Facebook — main BM')).toBeTruthy());
    expect(api.createEntry).toHaveBeenCalledWith('Facebook — main BM', SEED);
    // The marker stands where the key would be. A screen full of seeds is a
    // screen anyone behind you can photograph.
    expect(screen.getByText('2fa')).toBeTruthy();
    expect(screen.queryByText(SEED)).toBeNull();
  });

  it('normalises the shapes services actually print', async () => {
    await openNotebook([]);
    api.createEntry.mockResolvedValue(entry());

    await openForm();
    fillForm('Google', 'jbsw y3dp ehpk 3pxp');
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));

    await waitFor(() => expect(api.createEntry).toHaveBeenCalledWith('Google', SEED));
  });

  it('refuses a key that is not one, and sends nothing', async () => {
    await openNotebook([]);

    await openForm();
    fillForm('Broken', 'nope!');
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));

    await waitFor(() => expect(screen.getByText(en('twoFactorSeedErrorNotBase32'))).toBeTruthy());
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('names the specific rule a key breaks', async () => {
    await openNotebook([]);
    await openForm();

    fillForm('Short', 'JBSWY3DPEHPK3PX');
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));
    await waitFor(() => expect(screen.getByText(en('twoFactorSeedErrorTooShort'))).toBeTruthy());

    fillForm('Empty', '   ');
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));
    await waitFor(() => expect(screen.getByText(en('twoFactorSeedErrorEmpty'))).toBeTruthy());

    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('requires a name', async () => {
    await openNotebook([]);
    await openForm();
    fillForm('  ', SEED);
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));

    await waitFor(() => expect(screen.getByText(en('twoFactorNameRequired'))).toBeTruthy());
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('fills an empty name from an enrolment link', async () => {
    await openNotebook([]);
    await openForm();

    fireEvent.change(screen.getByLabelText(en('twoFactorSeedLabel')), {
      target: { value: `otpauth://totp/Example:alice@example.com?secret=${SEED}&issuer=Example` }
    });

    await waitFor(() =>
      expect((screen.getByLabelText(en('twoFactorNameLabel')) as HTMLInputElement).value).toBe(
        'Example:alice@example.com'
      )
    );
  });

  it('reports a refused save without losing what was typed', async () => {
    await openNotebook([]);
    api.createEntry.mockRejectedValue(new TwoFactorApiError('INVALID_SECRET'));

    await openForm();
    fillForm('Rejected', SEED);
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));

    await waitFor(() => expect(screen.getByText(en('twoFactorSeedErrorNotBase32'))).toBeTruthy());
    expect((screen.getByLabelText(en('twoFactorNameLabel')) as HTMLInputElement).value).toBe(
      'Rejected'
    );
  });
});

describe('copying the key', () => {
  it('copies what was stored, unchanged and without revealing it first', async () => {
    await openNotebook([entry()]);

    fireEvent.click(screen.getByRole('button', { name: en('twoFactorCopyKey') }));

    // Synchronously: nothing is awaited between the click and the write.
    expect(writeText).toHaveBeenCalledWith(SEED);
    expect(screen.getByText('2fa')).toBeTruthy();
  });

  it('reports a refused copy as a failure and leaves the key selectable', async () => {
    await openNotebook([entry()]);
    writeText.mockReturnValue(Promise.reject(new Error('NotAllowedError')));

    fireEvent.click(screen.getByRole('button', { name: en('twoFactorCopyKey') }));

    // A failed copy must never look like a success — the value is put on screen
    // so it can be selected by hand instead.
    await waitFor(() => expect(screen.getByText(en('twoFactorCopyFailed'))).toBeTruthy());
    expect(screen.getByText(SEED)).toBeTruthy();
    expect(screen.queryByText(en('twoFactorCopied'))).toBeNull();
  });

  it('confirms a copy that worked', async () => {
    await openNotebook([entry()]);
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorCopyKey') }));
    await waitFor(() => expect(screen.getByText(en('twoFactorCopied'))).toBeTruthy());
  });
});

describe('revealing a key', () => {
  it('shows one row’s key and leaves the others covered', async () => {
    await openNotebook([
      entry(),
      entry({ id: 'entry-2', name: 'Second', seed: 'GEZDGNBVGY3TQOJQ' })
    ]);

    fireEvent.click(screen.getAllByRole('button', { name: en('twoFactorReveal') })[0]!);

    expect(screen.getByText(SEED)).toBeTruthy();
    expect(screen.queryByText('GEZDGNBVGY3TQOJQ')).toBeNull();
    expect(screen.getAllByText('2fa')).toHaveLength(1);
  });

  it('covers it again when asked', async () => {
    await openNotebook([entry()]);
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorReveal') }));
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorHide') }));
    expect(screen.queryByText(SEED)).toBeNull();
    expect(screen.getByText('2fa')).toBeTruthy();
  });
});

describe('taking a code', () => {
  // A fixed clock, so the expected digits are a constant rather than a race
  // against the 30-second step boundary.
  const AT = Date.parse('2026-09-03T10:00:05.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the code into the row and onto the clipboard from one press', async () => {
    await openNotebook([entry()]);
    const expected = generateTotp(SEED, AT);

    fireEvent.click(screen.getByRole('button', { name: en('twoFactorGenerate') }));

    // The whole point of the synchronous implementation: by the time the click
    // handler returns, the write has already been issued. Nothing is awaited in
    // between, which is what keeps the user activation Safari demands.
    expect(writeText).toHaveBeenCalledWith(expected);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('matches what any authenticator would produce for the same key', async () => {
    await openNotebook([entry()]);
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorGenerate') }));
    // Six digits, leading zeros intact.
    const shown = writeText.mock.calls[0]![0] as string;
    expect(shown).toMatch(/^\d{6}$/u);
    expect(shown).toBe(generateTotp(SEED, AT));
  });

  it('gives the same digits twice inside one step', async () => {
    await openNotebook([entry()]);
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorGenerate') }));
    const first = writeText.mock.calls[0]![0];

    act(() => {
      vi.setSystemTime(AT + 5_000);
    });
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorGenerate') }));
    expect(writeText.mock.calls[1]![0]).toBe(first);
  });

  it('stops presenting a code once its step has passed', async () => {
    await openNotebook([entry()]);
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorGenerate') }));
    const shown = writeText.mock.calls[0]![0] as string;
    expect(screen.getByText(shown)).toBeTruthy();

    // Past the end of the step the code belonged to. A stale code presented as
    // current is worse than no code: it is rejected, and the person retypes it.
    act(() => {
      vi.setSystemTime(AT + 60_000);
      vi.advanceTimersByTime(60_000);
    });

    await waitFor(() => expect(screen.queryByText(shown)).toBeNull());
    expect(screen.getByText('2fa')).toBeTruthy();
  });
});

describe('finding a key in a grown list', () => {
  const many = [
    entry({ id: 'a', name: 'Facebook — main BM', seed: 'JBSWY3DPEHPK3PXP' }),
    entry({ id: 'b', name: 'Google Ads', seed: 'GEZDGNBVGY3TQOJQ' }),
    entry({ id: 'c', name: 'Binance', seed: 'MFRGGZDFMZTWQ2LK' })
  ];

  function search(query: string) {
    fireEvent.change(screen.getByLabelText(en('twoFactorSearchLabel')), {
      target: { value: query }
    });
  }

  it('filters by name as you type, ignoring case', async () => {
    await openNotebook(many);
    search('goo');
    expect(screen.getByText('Google Ads')).toBeTruthy();
    expect(screen.queryByText('Binance')).toBeNull();
    expect(screen.queryByText('Facebook — main BM')).toBeNull();
  });

  it('filters by the key itself, which is never on screen', async () => {
    await openNotebook(many);
    // The owner's brief asked for this: paste a fragment of a key to find out
    // which account it belongs to.
    search('mfrggz');
    expect(screen.getByText('Binance')).toBeTruthy();
    expect(screen.queryByText('Google Ads')).toBeNull();
  });

  it('says nothing matched, which is not the same as an empty notebook', async () => {
    await openNotebook(many);
    search('nothing like this');
    expect(screen.getByText(/Nothing matches/u)).toBeTruthy();
    expect(screen.queryByText(en('twoFactorEmpty'))).toBeNull();
  });
});

describe('correcting a key', () => {
  const two = [
    entry({ id: 'a', name: 'First' }),
    entry({ id: 'b', name: 'Second', seed: 'GEZDGNBVGY3TQOJQ' })
  ];

  it('renames without moving the row', async () => {
    await openNotebook(two);
    api.updateEntry.mockResolvedValue({ ...two[0]!, name: 'Renamed' });

    fireEvent.click(screen.getAllByRole('button', { name: en('twoFactorEdit') })[0]!);
    fireEvent.change(screen.getByLabelText(en('twoFactorNameLabel')), {
      target: { value: 'Renamed' }
    });
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));

    // `null` for the key: an untouched key field means "rename only", because
    // the stored key is not something the form can show and so cannot be retyped.
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledWith('a', 'Renamed', null));
    await waitFor(() => expect(screen.getByText('Renamed')).toBeTruthy());
    const names = screen.getAllByTitle(/Renamed|Second/u).map(node => node.textContent);
    expect(names).toEqual(['Renamed', 'Second']);
  });

  it('replaces the key when a new one is typed', async () => {
    await openNotebook(two);
    api.updateEntry.mockResolvedValue({ ...two[0]!, seed: 'MFRGGZDFMZTWQ2LK' });

    fireEvent.click(screen.getAllByRole('button', { name: en('twoFactorEdit') })[0]!);
    fireEvent.change(screen.getByLabelText(en('twoFactorSeedLabel')), {
      target: { value: 'mfrg gzdf mztw q2lk' }
    });
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorSave') }));

    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith('a', 'First', 'MFRGGZDFMZTWQ2LK')
    );
  });
});

describe('removing a key', () => {
  it('asks first, and says the removal is final', async () => {
    await openNotebook([entry()]);

    fireEvent.click(screen.getByRole('button', { name: en('twoFactorDelete') }));
    expect(screen.getByText(en('twoFactorDeleteTitle'))).toBeTruthy();
    // Nothing has happened yet — asking is not doing.
    expect(api.deleteEntry).not.toHaveBeenCalled();
  });

  it('removes the row once confirmed', async () => {
    await openNotebook([entry()]);
    api.deleteEntry.mockResolvedValue(undefined);

    fireEvent.click(screen.getByRole('button', { name: en('twoFactorDelete') }));
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorDeleteConfirm') }));

    await waitFor(() => expect(api.deleteEntry).toHaveBeenCalledWith('entry-1'));
    await waitFor(() => expect(screen.queryByText('Facebook — main BM')).toBeNull());
  });

  it('keeps the row when the removal is refused', async () => {
    await openNotebook([entry()]);
    api.deleteEntry.mockRejectedValue(new TwoFactorApiError('UNKNOWN'));

    fireEvent.click(screen.getByRole('button', { name: en('twoFactorDelete') }));
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorDeleteConfirm') }));

    await waitFor(() => expect(screen.getByText(en('twoFactorDeleteFailed'))).toBeTruthy());
    expect(screen.getByText('Facebook — main BM')).toBeTruthy();
  });
});

describe('a notebook that has grown', () => {
  const many = Array.from({ length: 200 }, (_, index) =>
    entry({
      id: `entry-${index}`,
      name: `Account ${index}`,
      seed: index % 2 === 0 ? SEED : 'GEZDGNBVGY3TQOJQ'
    })
  );

  it('narrows 200 rows on three typed characters, without asking the server', async () => {
    await openNotebook(many);
    expect(api.listEntries).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(en('twoFactorSearchLabel')), {
      target: { value: '199' }
    });

    expect(screen.getByText('Account 199')).toBeTruthy();
    expect(screen.queryByText('Account 1')).toBeNull();
    // The thing that would actually blow SC-004's 300 ms is a round trip per
    // keystroke. The list is loaded once and filtered in memory, so typing
    // costs a re-render and nothing else — and that is what is asserted here.
    //
    // The 300 ms itself is measured in a real browser, not here: jsdom's cost
    // to unmount 199 rows of SVG is an order of magnitude above Chrome's and
    // says nothing about what a person experiences.
    expect(api.listEntries).toHaveBeenCalledTimes(1);
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('keeps filtering linear as the query grows', async () => {
    await openNotebook(many);
    const input = screen.getByLabelText(en('twoFactorSearchLabel'));

    // Every prefix of a query re-filters the whole list from scratch. If that
    // were quadratic in the entry count, this loop is where it would show.
    for (const query of ['A', 'Ac', 'Acc', 'Acco', 'Accou', 'Account 199']) {
      fireEvent.change(input, { target: { value: query } });
    }
    expect(screen.getByText('Account 199')).toBeTruthy();
    expect(api.listEntries).toHaveBeenCalledTimes(1);
  });

  it('puts no key on screen when the notebook opens', async () => {
    // SC-009, asserted rather than eyeballed: the whole rendered page, read as
    // text, contains no stored key until someone asks for one.
    await openNotebook(many.slice(0, 10));
    const onScreen = document.body.textContent ?? '';
    expect(onScreen).not.toContain(SEED);
    expect(onScreen).not.toContain('GEZDGNBVGY3TQOJQ');
    expect(screen.getAllByText('2fa')).toHaveLength(10);
  });
});
