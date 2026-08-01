import { describe, expect, it } from 'vitest';
import {
  MATERIAL_CLASSIFIER_VERSION,
  classifyMaterial
} from '../packages/shared/src/team/material-category';

describe('canonical team material classification', () => {
  it.each([
    ['video/mp4; codecs=avc1', 'ZIP', 'video', 'mime'],
    ['image/webp', 'mp4', 'image', 'mime'],
    ['application/octet-stream', '.VTT', 'transcript', 'extension'],
    ['application/x-unrecognized', 'HtMl', 'landing', 'extension'],
    [null, '7Z', 'archive', 'extension'],
    [null, 'unknown', 'other', 'fallback']
  ] as const)('%s + %s becomes %s via %s', (mimeType, fileExtension, category, source) => {
    expect(classifyMaterial({ kind: 'file', mimeType, fileExtension })).toMatchObject({
      category,
      source,
      version: MATERIAL_CLASSIFIER_VERSION
    });
  });

  it('uses a conflicting recognized extension when text/plain is not actually a transcript', () => {
    expect(
      classifyMaterial({ kind: 'file', mimeType: 'text/plain', fileExtension: 'mp4' })
    ).toMatchObject({ category: 'video', source: 'extension' });
  });

  it('classifies folders and shortcuts without dereferencing a shortcut target', () => {
    expect(classifyMaterial({ kind: 'folder', mimeType: null, fileExtension: null })).toMatchObject(
      {
        category: null,
        source: 'fallback'
      }
    );
    expect(
      classifyMaterial({ kind: 'shortcut', mimeType: 'video/mp4', fileExtension: 'mp4' })
    ).toMatchObject({ category: 'other', source: 'fallback' });
  });

  it('promotes an archive only for a validation bound to the current source version', () => {
    const current = classifyMaterial({
      kind: 'file',
      mimeType: 'application/zip',
      fileExtension: 'zip',
      sourceVersion: 'drive-version-7',
      landingPackageValidated: true,
      landingValidationSourceVersion: 'drive-version-7',
      landingValidationFingerprint: 'sha256:fixture-v7'
    });
    const changed = classifyMaterial({
      kind: 'file',
      mimeType: 'application/zip',
      fileExtension: 'zip',
      sourceVersion: 'drive-version-8',
      landingPackageValidated: true,
      landingValidationSourceVersion: 'drive-version-7',
      landingValidationFingerprint: 'sha256:fixture-v7'
    });

    expect(current).toMatchObject({ category: 'landing', source: 'inspected_landing' });
    expect(changed).toMatchObject({ category: 'archive', source: 'mime' });
  });
});
