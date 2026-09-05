// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptionJob } from '@video-compressor/shared';
import type { Translate } from '../apps/web/src/components/ui.js';
import {
  TranscriptionRow,
  type TranscriptionRowActions
} from '../apps/web/src/transcription/TranscriptionRow.js';

const t = ((key: string, values?: Record<string, string | number>) =>
  values ? `${key} ${Object.values(values).join(' ')}` : key) as unknown as Translate;

function actions(): TranscriptionRowActions {
  return {
    select: vi.fn(),
    start: vi.fn(),
    startWith: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    retry: vi.fn(),
    remove: vi.fn(),
    reveal: vi.fn(),
    installTranslator: vi.fn(),
    setLanguage: vi.fn(),
    view: vi.fn(),
    copy: vi.fn(async () => true),
    translate: vi.fn(async () => {}),
    export: vi.fn()
  };
}

function job(patch: Partial<TranscriptionJob> = {}): TranscriptionJob {
  return {
    id: 'job-1',
    inputPath: '/tmp/uz.mp4',
    fileName: 'uz.mp4',
    sourceKind: 'local',
    sourceKey: null,
    durationSeconds: 45,
    status: 'completed',
    progress: 100,
    requestedLanguage: 'auto',
    detectedLanguage: 'az',
    languageSource: 'probe',
    languageConfidence: 0.88,
    quality: 'fast',
    text: null,
    characters: 300,
    preview: 'Əgər bu sadır bulmasa…',
    translation: null,
    error: null,
    errorDetails: null,
    batchId: null,
    createdAt: 0,
    startedAt: 0,
    finishedAt: 1,
    ...patch
  };
}

function row(overrides: Partial<TranscriptionJob> = {}, rowActions = actions()) {
  render(
    <TranscriptionRow
      job={job(overrides)}
      index={0}
      language="uk"
      connected
      selected={false}
      actions={rowActions}
      t={t}
    />
  );
  return rowActions;
}

describe('the language a row shows', () => {
  it('says it is still listening while the probe runs', () => {
    row({
      status: 'ready',
      detectedLanguage: null,
      languageProbing: true,
      languageSource: undefined
    });
    expect(screen.getByText('transcriptionLanguageProbing')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('marks a guess inside a family the detector mixes up, and offers those first', () => {
    row();
    const picker = screen.getByRole('combobox', { name: 'transcriptionSpokenLanguageOf uz.mp4' });
    // Azerbaijani, in Ukrainian, because that is the interface's language.
    expect((picker as HTMLInputElement).value).toBe('Азербайджанська');
    expect(picker.closest('.transcription-row-language')?.className).toContain('is-uncertain');
    fireEvent.focus(picker);
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    // Automatic first, then the languages Whisper confuses with Azerbaijani.
    expect(options.slice(0, 3).map(option => option.textContent)).toEqual([
      'transcriptionLanguageAuto',
      'Узбецька',
      'Турецька'
    ]);
  });

  it('does not second-guess a language a person chose', () => {
    row({ detectedLanguage: 'uz', languageSource: 'manual', languageConfidence: undefined });
    const picker = screen.getByRole('combobox', { name: 'transcriptionSpokenLanguageOf uz.mp4' });
    expect(picker.closest('.transcription-row-language')?.className).not.toContain('is-uncertain');
  });

  it('hands a correction back to the page', () => {
    const rowActions = row();
    fireEvent.focus(screen.getByRole('combobox', { name: 'transcriptionSpokenLanguageOf uz.mp4' }));
    fireEvent.click(screen.getByRole('option', { name: 'Узбецька' }));
    expect(rowActions.setLanguage).toHaveBeenCalledWith('job-1', 'uz');
  });

  it('is not editable while the run that would answer it is going', () => {
    row({ status: 'processing', progress: 40 });
    expect(
      (
        screen.getByRole('combobox', {
          name: 'transcriptionSpokenLanguageOf uz.mp4'
        }) as HTMLInputElement
      ).disabled
    ).toBe(true);
  });
});

describe('the panel behind the doubt marker', () => {
  // Real figures: the model's own confidence averaged over four fragments, which is why
  // they stop well short of a hundred.
  const measured = {
    languageCandidates: [
      { language: 'az', share: 0.35 },
      { language: 'fa', share: 0.14 },
      { language: 'en', share: 0.13 }
    ],
    languageSamples: 4,
    languageConfidence: 0.35
  } satisfies Partial<TranscriptionJob>;

  it('shows what each fragment said, and how many there were', () => {
    row(measured);
    fireEvent.click(screen.getByRole('button', { name: 'transcriptionLanguageDoubt' }));
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('transcriptionLanguageDoubtSamples 4');
    expect(within(panel).getByRole('button', { name: /Азербайджанська/ }).textContent).toContain(
      '35%'
    );
    expect(within(panel).getByRole('button', { name: /Перська/ }).textContent).toContain('14%');
    // What the model kept for languages it never named, shown rather than divided away —
    // otherwise a file it is unsure of would be labelled a confident hundred per cent.
    const rest = panel.querySelector('.transcription-language-doubt-rest');
    expect(rest?.textContent).toContain('transcriptionLanguageDoubtRest');
    expect(rest?.textContent).toContain('38%');
  });

  it('shows the share beside the name, and opens the panel from it too', () => {
    row(measured);
    const share = screen.getByRole('button', { name: /^35% · transcriptionLanguageDoubt$/ });
    expect(share.textContent).toBe('35%');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(share);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // And closes again from the same place.
    fireEvent.click(share);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers no figure to press where nothing measured one', () => {
    row({ languageSource: 'run', languageConfidence: undefined, languageCandidates: undefined });
    expect(document.querySelector('.transcription-row-language-share')).toBeNull();
    expect(screen.getByRole('button', { name: 'transcriptionLanguageDoubt' })).toBeTruthy();
  });

  it('offers the family it never votes for, Uzbek included, and sets the one chosen', () => {
    const rowActions = row(measured);
    fireEvent.click(screen.getByRole('button', { name: 'transcriptionLanguageDoubt' }));
    const panel = screen.getByRole('dialog');
    // Azerbaijani's family, minus the ones already listed with a share. Deliberately not
    // rows of the table: they were never measured, and a bar of zero beside a language the
    // recording is actually in would be a claim, not a blank.
    const family = [...panel.querySelectorAll('.transcription-language-doubt-neighbours button')];
    expect(family.map(button => button.textContent)).toEqual([
      'Узбецька',
      'Турецька',
      'Туркменська',
      'Казахська'
    ]);
    expect(
      panel.querySelector(
        '.transcription-language-doubt-neighbours .transcription-language-doubt-bar'
      )
    ).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Узбецька' }));
    expect(rowActions.setLanguage).toHaveBeenCalledWith('job-1', 'uz');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts no figure on a language the run named, only the ways to correct it', () => {
    row({
      languageSource: 'run',
      languageConfidence: undefined,
      languageCandidates: undefined,
      languageSamples: undefined
    });
    fireEvent.click(screen.getByRole('button', { name: 'transcriptionLanguageDoubt' }));
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('transcriptionLanguageDoubtFromRun');
    expect(panel.textContent).not.toContain('%');
    expect(within(panel).getByRole('button', { name: 'Узбецька' })).toBeTruthy();
  });

  it('closes on Escape', () => {
    row(measured);
    fireEvent.click(screen.getByRole('button', { name: 'transcriptionLanguageDoubt' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('what a finished row offers', () => {
  it('names every action, the quiet ones included', () => {
    row();
    for (const name of [
      'transcriptionView',
      'transcriptionCopy',
      'transcriptionRepeat',
      'showInFolder',
      'transcriptionRemove'
    ]) {
      expect(screen.getByRole('button', { name }), name).toBeTruthy();
    }
  });
});
