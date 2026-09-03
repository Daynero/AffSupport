// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `act` from the testing library rather than from React: it sets the act
// environment flag, which React otherwise warns about on every call.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { generateTotp } from '../packages/shared/src/totp.js';

/**
 * Feature 016: the wallet as a person meets it.
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
const OTHER_SEED = 'GEZDGNBVGY3TQOJQ';

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
const enWith = (key: Parameters<typeof translate>[1], values: Record<string, string | number>) =>
  translate('en', key, values);

/** The digits shown for an account — which are also the button that copies them. */
function codeButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: enWith('twoFactorCopyCodeFor', { name }) });
}

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
    value: { writeText, readText: vi.fn(() => Promise.resolve('')) },
    configurable: true
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Renders and waits for the first load to settle. */
async function openWallet(entries: TwoFactorEntry[] = []) {
  api.listEntries.mockResolvedValue(entries);
  render(<TwoFactorPage />);
  await waitFor(() => expect(api.listEntries).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(en('twoFactorLoading'))).toBeNull());
}

/** The row carrying a given account name. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

/** The one row being edited — a correction, or the draft for a new account. */
function editRow(): HTMLElement {
  const row = document.querySelector('tr.is-editing');
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

function fillEditRow(name: string, seed: string) {
  const row = editRow();
  fireEvent.change(within(row).getByLabelText(en('twoFactorNamePlaceholder')), {
    target: { value: name }
  });
  const keyField =
    within(row).queryByLabelText(en('twoFactorKeyPlaceholder')) ??
    within(row).getByLabelText(en('twoFactorKeyPlaceholderKeep'));
  fireEvent.change(keyField, { target: { value: seed } });
}

function saveEditRow() {
  fireEvent.click(within(editRow()).getByRole('button', { name: en('twoFactorSave') }));
}

function openAdd() {
  fireEvent.click(screen.getByRole('button', { name: en('twoFactorAdd') }));
}

function openRowMenu(name: string) {
  fireEvent.click(within(rowFor(name)).getByRole('button', { name: en('twoFactorRowMenu') }));
}

const names = () => [...document.querySelectorAll('.tfa-name')].map(node => node.textContent);

describe('an empty wallet', () => {
  it('says it is empty rather than showing a blank page', async () => {
    await openWallet([]);
    expect(screen.getByText(en('twoFactorEmpty'))).toBeTruthy();
  });
});

describe('adding an account', () => {
  it('stores it and shows one row, with the key nowhere on screen', async () => {
    await openWallet([]);
    api.createEntry.mockResolvedValue(entry());

    openAdd();
    fillEditRow('Facebook — main BM', SEED);
    saveEditRow();

    await waitFor(() => expect(screen.getByText('Facebook — main BM')).toBeTruthy());
    expect(api.createEntry).toHaveBeenCalledWith('Facebook — main BM', SEED);
    // The key is never a column: a screen full of keys is a screen anyone
    // standing behind you can photograph.
    expect(document.body.textContent).not.toContain(SEED);
  });

  it('normalises the shapes services actually print', async () => {
    await openWallet([]);
    api.createEntry.mockResolvedValue(entry());

    openAdd();
    fillEditRow('Google', 'jbsw y3dp ehpk 3pxp');
    saveEditRow();

    await waitFor(() => expect(api.createEntry).toHaveBeenCalledWith('Google', SEED));
  });

  it('refuses a key that is not one, and sends nothing', async () => {
    await openWallet([]);
    openAdd();
    fillEditRow('Broken', 'nope!');
    saveEditRow();

    await waitFor(() => expect(screen.getByText(en('twoFactorSeedErrorNotBase32'))).toBeTruthy());
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('names the specific rule a key breaks', async () => {
    await openWallet([]);
    openAdd();

    fillEditRow('Short', 'JBSWY3DPEHPK3PX');
    saveEditRow();
    await waitFor(() => expect(screen.getByText(en('twoFactorSeedErrorTooShort'))).toBeTruthy());

    fillEditRow('Empty', '   ');
    saveEditRow();
    await waitFor(() => expect(screen.getByText(en('twoFactorSeedErrorEmpty'))).toBeTruthy());

    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('requires a name', async () => {
    await openWallet([]);
    openAdd();
    fillEditRow('  ', SEED);
    saveEditRow();

    await waitFor(() => expect(screen.getByText(en('twoFactorNameRequired'))).toBeTruthy());
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('fills an empty name from an enrolment link', async () => {
    await openWallet([]);
    openAdd();

    fireEvent.change(within(editRow()).getByLabelText(en('twoFactorKeyPlaceholder')), {
      target: { value: `otpauth://totp/Example:alice@example.com?secret=${SEED}&issuer=Example` }
    });

    await waitFor(() =>
      expect(
        (within(editRow()).getByLabelText(en('twoFactorNamePlaceholder')) as HTMLInputElement).value
      ).toBe('Example:alice@example.com')
    );
  });

  it('keeps what was typed when the save is refused', async () => {
    await openWallet([]);
    api.createEntry.mockRejectedValue(new TwoFactorApiError('INVALID_SECRET'));

    openAdd();
    fillEditRow('Rejected', SEED);
    saveEditRow();

    await waitFor(() => expect(screen.getByText(en('twoFactorSeedErrorNotBase32'))).toBeTruthy());
    expect(
      (within(editRow()).getByLabelText(en('twoFactorNamePlaceholder')) as HTMLInputElement).value
    ).toBe('Rejected');
  });
});

describe('the code of a stored account', () => {
  const AT = Date.parse('2026-09-03T10:00:05.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is on screen without being asked for', async () => {
    await openWallet([entry()]);
    const expected = generateTotp(SEED, AT);
    // The reason the tool exists, visible rather than one click away. Shown
    // grouped, the way six digits are read and typed.
    expect(screen.getByText(`${expected.slice(0, 3)} ${expected.slice(3)}`)).toBeTruthy();
  });

  it('matches what any authenticator would produce for the same key', async () => {
    await openWallet([entry()]);
    fireEvent.click(codeButton('Facebook — main BM'));
    const shown = writeText.mock.calls[0]![0] as string;
    expect(shown).toMatch(/^\d{6}$/u);
    expect(shown).toBe(generateTotp(SEED, AT));
  });

  it('reaches the clipboard from one press on the digits themselves', async () => {
    await openWallet([entry()]);
    fireEvent.click(codeButton('Facebook — main BM'));

    // The whole point of the synchronous implementation: by the time the click
    // handler returns, the write has already been issued. Nothing is awaited in
    // between, which is what keeps the user activation Safari demands.
    expect(writeText).toHaveBeenCalledWith(generateTotp(SEED, AT));
  });

  it('turns over when its step does, rather than going stale', async () => {
    await openWallet([entry()]);
    const first = generateTotp(SEED, AT);
    expect(screen.getByText(`${first.slice(0, 3)} ${first.slice(3)}`)).toBeTruthy();

    // Just past the boundary, so exactly one step turns over. The assertion is
    // synchronous: the state change happens inside `act`, and a `waitFor` here
    // would race the countdown's own interval under fake timers.
    const later = AT + 25_100;
    act(() => {
      vi.setSystemTime(later);
      vi.advanceTimersByTime(25_100);
    });

    const next = generateTotp(SEED, later);
    expect(next).not.toBe(first);
    expect(screen.getByText(`${next.slice(0, 3)} ${next.slice(3)}`)).toBeTruthy();
    expect(screen.queryByText(`${first.slice(0, 3)} ${first.slice(3)}`)).toBeNull();
  });

  it('shares one countdown with every other code on the page', async () => {
    await openWallet([entry(), entry({ id: 'entry-2', name: 'Second', seed: OTHER_SEED })]);
    // Two accounts, two codes, one indicator — they all turn over together, so
    // a countdown per row would be the same number repeated.
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('reports a refused copy as a failure rather than a success', async () => {
    await openWallet([entry()]);
    writeText.mockReturnValue(Promise.reject(new Error('NotAllowedError')));

    fireEvent.click(codeButton('Facebook — main BM'));

    await waitFor(() => expect(screen.getByText(en('twoFactorCopyFailed'))).toBeTruthy());
  });
});

describe('a code for a key that is not stored', () => {
  const AT = Date.parse('2026-09-03T10:00:05.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const quickBar = () => screen.getByRole('region', { name: en('twoFactorQuickCode') });

  function paste(value: string) {
    fireEvent.change(within(quickBar()).getByLabelText(en('twoFactorQuickPlaceholder')), {
      target: { value }
    });
  }

  it('is there without being asked for', async () => {
    await openWallet([]);
    // Not behind a toggle: the moment somebody needs a code for a key they have
    // not stored is not a moment to go looking for the control that makes one.
    expect(quickBar()).toBeTruthy();
    expect(within(quickBar()).getByLabelText(en('twoFactorQuickPlaceholder'))).toBeTruthy();
  });

  it('answers as the key is pasted, with nothing to press first', async () => {
    await openWallet([]);
    paste(SEED);

    const expected = generateTotp(SEED, AT);
    expect(
      within(quickBar()).getByText(`${expected.slice(0, 3)} ${expected.slice(3)}`)
    ).toBeTruthy();
    // And nothing typed here reaches the database.
    expect(api.createEntry).not.toHaveBeenCalled();
  });

  it('copies from a press on the digits, like any other code', async () => {
    await openWallet([]);
    paste(SEED);
    fireEvent.click(
      within(quickBar()).getByRole('button', {
        name: enWith('twoFactorCopyCodeFor', { name: en('twoFactorQuickCode') })
      })
    );
    expect(writeText).toHaveBeenCalledWith(generateTotp(SEED, AT));
  });

  it('accepts an enrolment link as readily as a bare key', async () => {
    await openWallet([]);
    paste(`otpauth://totp/Example?secret=${SEED}`);
    const expected = generateTotp(SEED, AT);
    expect(
      within(quickBar()).getByText(`${expected.slice(0, 3)} ${expected.slice(3)}`)
    ).toBeTruthy();
  });

  it('says which rule a bad key breaks instead of producing digits', async () => {
    await openWallet([]);
    paste('nope!');
    expect(within(quickBar()).getByText(en('twoFactorSeedErrorNotBase32'))).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('stays quiet while there is too little typed to be wrong about', async () => {
    await openWallet([]);
    paste('JB');
    // Complaining at the second character would be shouting at somebody
    // mid-paste.
    expect(within(quickBar()).queryByRole('alert')).toBeNull();
  });
});

describe('the key itself', () => {
  it('is copied from the overflow menu, unchanged', async () => {
    await openWallet([entry()]);
    openRowMenu('Facebook — main BM');
    fireEvent.click(screen.getByRole('menuitem', { name: en('twoFactorCopyKey') }));
    expect(writeText).toHaveBeenCalledWith(SEED);
  });

  it('is shown only for the row that asked for it', async () => {
    await openWallet([entry(), entry({ id: 'entry-2', name: 'Second', seed: OTHER_SEED })]);

    openRowMenu('Facebook — main BM');
    fireEvent.click(screen.getByRole('menuitem', { name: en('twoFactorReveal') }));

    expect(screen.getByText(SEED)).toBeTruthy();
    expect(screen.queryByText(OTHER_SEED)).toBeNull();
  });

  it('is put on screen when the clipboard refuses it', async () => {
    await openWallet([entry()]);
    writeText.mockReturnValue(Promise.reject(new Error('NotAllowedError')));

    openRowMenu('Facebook — main BM');
    fireEvent.click(screen.getByRole('menuitem', { name: en('twoFactorCopyKey') }));

    // A failed copy must never look like a success — the value goes on screen
    // so it can be selected by hand instead.
    await waitFor(() => expect(screen.getByText(SEED)).toBeTruthy());
  });
});

describe('finding an account', () => {
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
    await openWallet(many);
    search('goo');
    expect(screen.getByText('Google Ads')).toBeTruthy();
    expect(screen.queryByText('Binance')).toBeNull();
  });

  it('filters by the key itself, which is never on screen', async () => {
    await openWallet(many);
    // The owner's brief asked for this: paste a fragment of a key to find out
    // which account it belongs to.
    search('mfrggz');
    expect(screen.getByText('Binance')).toBeTruthy();
    expect(screen.queryByText('Google Ads')).toBeNull();
  });

  it('says nothing matched, which is not the same as an empty wallet', async () => {
    await openWallet(many);
    search('nothing like this');
    expect(screen.getByText(/Nothing matches/u)).toBeTruthy();
    expect(screen.queryByText(en('twoFactorEmpty'))).toBeNull();
  });

  it('sorts by name, and the other way round', async () => {
    await openWallet(many);
    expect(names()).toEqual(['Binance', 'Facebook — main BM', 'Google Ads']);

    fireEvent.click(screen.getByRole('button', { name: /Sort:/u }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: en('twoFactorSortZa') }));
    expect(names()).toEqual(['Google Ads', 'Facebook — main BM', 'Binance']);
  });
});

describe('correcting an account', () => {
  const two = [
    entry({ id: 'a', name: 'Alpha' }),
    entry({ id: 'b', name: 'Beta', seed: OTHER_SEED })
  ];

  it('renames without moving the row', async () => {
    await openWallet(two);
    api.updateEntry.mockResolvedValue({ ...two[0]!, name: 'Alpha renamed' });

    openRowMenu('Alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: en('twoFactorEdit') }));
    fireEvent.change(within(editRow()).getByLabelText(en('twoFactorNamePlaceholder')), {
      target: { value: 'Alpha renamed' }
    });
    saveEditRow();

    // `null` for the key: an untouched key field means "rename only", because
    // the stored key is not something the row can show and so cannot be retyped.
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledWith('a', 'Alpha renamed', null));
    await waitFor(() => expect(names()).toEqual(['Alpha renamed', 'Beta']));
  });

  it('replaces the key when a new one is typed', async () => {
    await openWallet(two);
    api.updateEntry.mockResolvedValue({ ...two[0]!, seed: 'MFRGGZDFMZTWQ2LK' });

    openRowMenu('Alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: en('twoFactorEdit') }));
    fireEvent.change(within(editRow()).getByLabelText(en('twoFactorKeyPlaceholderKeep')), {
      target: { value: 'mfrg gzdf mztw q2lk' }
    });
    saveEditRow();

    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith('a', 'Alpha', 'MFRGGZDFMZTWQ2LK')
    );
  });
});

describe('removing an account', () => {
  it('asks first, and says the removal is final', async () => {
    await openWallet([entry()]);
    openRowMenu('Facebook — main BM');
    fireEvent.click(screen.getByRole('menuitem', { name: en('twoFactorDelete') }));

    expect(screen.getByText(en('twoFactorDeleteTitle'))).toBeTruthy();
    // Nothing has happened yet — asking is not doing.
    expect(api.deleteEntry).not.toHaveBeenCalled();
  });

  it('removes the row once confirmed', async () => {
    await openWallet([entry()]);
    api.deleteEntry.mockResolvedValue(undefined);

    openRowMenu('Facebook — main BM');
    fireEvent.click(screen.getByRole('menuitem', { name: en('twoFactorDelete') }));
    fireEvent.click(screen.getByRole('button', { name: en('twoFactorDeleteConfirm') }));

    await waitFor(() => expect(api.deleteEntry).toHaveBeenCalledWith('entry-1'));
    await waitFor(() => expect(screen.queryByText('Facebook — main BM')).toBeNull());
  });

  it('takes several at once when they are selected', async () => {
    await openWallet([entry({ id: 'a', name: 'Alpha' }), entry({ id: 'b', name: 'Beta' })]);
    api.deleteEntry.mockResolvedValue(undefined);

    fireEvent.click(screen.getByLabelText(en('twoFactorSelectAll')));
    fireEvent.click(screen.getByRole('button', { name: /Delete selected/u }));

    await waitFor(() => expect(api.deleteEntry).toHaveBeenCalledTimes(2));
    expect(api.deleteEntry).toHaveBeenCalledWith('a');
    expect(api.deleteEntry).toHaveBeenCalledWith('b');
  });
});

describe('a wallet that has grown', () => {
  const many = Array.from({ length: 200 }, (_, index) =>
    entry({
      id: `entry-${index}`,
      name: `Account ${index}`,
      seed: index % 2 === 0 ? SEED : OTHER_SEED
    })
  );

  it('narrows 200 rows on three typed characters, without asking the server', async () => {
    await openWallet(many);
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
  });

  it('puts no key on screen when the wallet opens', async () => {
    // SC-009, asserted rather than eyeballed: the whole rendered page, read as
    // text, contains no stored key until someone asks for one.
    await openWallet(many.slice(0, 10));
    const onScreen = document.body.textContent ?? '';
    expect(onScreen).not.toContain(SEED);
    expect(onScreen).not.toContain(OTHER_SEED);
  });
});
