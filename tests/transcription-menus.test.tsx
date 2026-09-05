// @vitest-environment jsdom

import React, { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Translate } from '../apps/web/src/components/ui.js';
import { useAnchoredLayer } from '../apps/web/src/components/useAnchoredLayer.js';
import { ExportMenu } from '../apps/web/src/transcription/ExportMenu.js';
import { LanguageCombobox } from '../apps/web/src/transcription/LanguageCombobox.js';
import { TranscriptionCopyMenu } from '../apps/web/src/transcription/TranscriptionCopyMenu.js';

/** Keys back as words, with their values, so a test reads what a person would. */
const t = ((key: string, values?: Record<string, string | number>) =>
  values ? `${key} ${Object.values(values).join(' ')}` : key) as unknown as Translate;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('export menu', () => {
  it('opens on the body when portalled, names why formats are unavailable, and walks by arrow', () => {
    const onExport = vi.fn();
    const { container } = render(
      <ExportMenu hasTimings={false} hasTranslation={false} onExport={onExport} portal t={t} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'transcriptionExportOptions' }));
    const menu = screen.getByRole('menu');
    // Portalled: the card that would clip it is not an ancestor.
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
    const items = screen.getAllByRole('menuitem');
    // txt for the transcript only; the timed formats and the translation groups are off.
    expect(items.filter(item => !(item as HTMLButtonElement).disabled)).toHaveLength(1);
    expect(menu.textContent).toContain('transcriptionExportNoTimings');
    expect(menu.textContent).toContain('transcriptionExportNoTranslation');

    // Focus lands on the first enabled item; arrows wrap around the enabled ones.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    fireEvent.click(items[0]);
    expect(onExport).toHaveBeenCalledWith('txt', 'transcript');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape without closing what is above it', () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <ExportMenu hasTimings hasTranslation onExport={() => {}} t={t} />
      </div>
    );
    const toggle = screen.getByRole('button', { name: 'transcriptionExportOptions' });
    fireEvent.click(toggle);
    expect(
      screen.getAllByRole('menuitem').every(item => !(item as HTMLButtonElement).disabled)
    ).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});

describe('language combobox', () => {
  const codes = ['auto', 'en', 'uk', 'de', 'ar'] as const;

  it('filters by typing, wraps with the arrows, and keeps the current choice highlighted', () => {
    const onChange = vi.fn();
    render(
      <LanguageCombobox
        value="uk"
        codes={codes}
        language="uk"
        label="Мова"
        autoLabel="Авто"
        emptyLabel="Нічого"
        onChange={onChange}
      />
    );
    const input = screen.getByRole('combobox');
    expect(input).toHaveProperty('value', 'Українська');
    // The listbox exists only while open, and so does the reference to it.
    expect(input.getAttribute('aria-controls')).toBeNull();
    fireEvent.focus(input);
    const listbox = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    // Auto first, then names in order; the highlight sits on the current value.
    const options = () => screen.getAllByRole('option');
    expect(options()[0].textContent).toBe('Авто');
    expect(listbox.querySelector('li.is-active')?.textContent).toBe('Українська');

    // From the last entry, down wraps to the first.
    const last = options().length - 1;
    for (
      let index = options().findIndex(o => o.classList.contains('is-active'));
      index < last;
      index += 1
    ) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    }
    expect(listbox.querySelector('li.is-active')).toBe(options()[last]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(listbox.querySelector('li.is-active')).toBe(options()[0]);

    fireEvent.change(input, { target: { value: 'нім' } });
    expect(options().map(o => o.textContent)).toEqual(['Німецька']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('de');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('can be emptied to type a search into', () => {
    render(
      <LanguageCombobox
        value="uk"
        codes={codes}
        language="uk"
        label="Мова"
        autoLabel="Авто"
        onChange={() => {}}
      />
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.focus(input);
    // Deleting the last character used to redraw the chosen language's name, so the field
    // could not be cleared at all — an empty box is a real state, not "nothing typed".
    fireEvent.change(input, { target: { value: 'нім' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    // And an empty search is every language, not none.
    expect(screen.getAllByRole('option').length).toBe(codes.length);
    // Leaving puts the chosen language back.
    fireEvent.blur(input);
    expect(input.value).toBe('Українська');
  });

  it('says when nothing matches and puts a portalled list on the body', () => {
    const { container } = render(
      <LanguageCombobox
        value="en"
        codes={codes}
        language="uk"
        label="Мова"
        emptyLabel="Нічого не знайдено"
        portal
        onChange={() => {}}
      />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    const listbox = screen.getByRole('listbox');
    expect(container.contains(listbox)).toBe(false);
    expect(listbox.style.position).toBe('fixed');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(listbox.textContent).toBe('Нічого не знайдено');
  });
});

describe('batch copy menu', () => {
  it('names the scope on the button and changes it from the popover', () => {
    const onScopeChange = vi.fn();
    const onContentChange = vi.fn();
    const onCopy = vi.fn();
    const view = render(
      <TranscriptionCopyMenu
        scope="finished"
        content="transcript"
        finishedCount={3}
        selectedCount={1}
        busy={false}
        disabled={false}
        onScopeChange={onScopeChange}
        onContentChange={onContentChange}
        onCopy={onCopy}
        t={t}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'transcriptionCopyFinished 3' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'transcriptionCopyOptions' }));
    const dialog = screen.getByRole('dialog');
    const radios = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.length).toBeGreaterThanOrEqual(4);
    // The scope group's other choice: the one not checked.
    const otherScope = radios.find(radio => radio.name.endsWith('-scope') && !radio.checked);
    fireEvent.click(otherScope!);
    expect(onScopeChange).toHaveBeenCalledWith('selected');
    view.rerender(
      <TranscriptionCopyMenu
        scope="selected"
        content="transcript"
        finishedCount={3}
        selectedCount={1}
        busy={false}
        disabled={false}
        onScopeChange={onScopeChange}
        onContentChange={onContentChange}
        onCopy={onCopy}
        t={t}
      />
    );
    expect(screen.getByRole('button', { name: 'transcriptionCopySelected 1' })).toBeTruthy();
  });
});

describe('anchored layer', () => {
  function Host({ open, align }: { open: boolean; align?: 'start' | 'end' }) {
    const anchor = useRef<HTMLDivElement>(null);
    const layer = useRef<HTMLDivElement>(null);
    const style = useAnchoredLayer(anchor, layer, open, { align, gap: 6 });
    return (
      <>
        <div ref={anchor} data-testid="anchor" />
        <div ref={layer} data-testid="layer" style={style ?? undefined} />
      </>
    );
  }
  const rect = (element: HTMLElement, box: Partial<DOMRect>) =>
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...box
    } as DOMRect);

  it('sits under the anchor while there is room, and above it when there is more room there', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    const view = render(<Host open={false} />);
    const anchor = screen.getByTestId('anchor');
    const layer = screen.getByTestId('layer');
    rect(anchor, { top: 100, bottom: 130, left: 700, right: 900, width: 200, height: 30 });
    Object.defineProperty(layer, 'offsetHeight', { configurable: true, value: 200 });
    Object.defineProperty(layer, 'offsetWidth', { configurable: true, value: 300 });
    act(() => view.rerender(<Host open align="end" />));
    expect(layer.style.position).toBe('fixed');
    expect(layer.style.top).toBe('136px');
    // Right-aligned to the anchor's right edge.
    expect(layer.style.left).toBe('600px');

    // Near the bottom of the window the layer flips above the anchor.
    rect(anchor, { top: 500, bottom: 530, left: 700, right: 900, width: 200, height: 30 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(Number.parseFloat(layer.style.top)).toBeLessThan(500);
    expect(Number.parseFloat(layer.style.top) + 200).toBeLessThanOrEqual(494);

    act(() => view.rerender(<Host open={false} />));
    expect(layer.getAttribute('style')).toBeFalsy();
  });
});
