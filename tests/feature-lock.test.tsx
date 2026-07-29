// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FeatureLockDialog from '../apps/web/src/components/FeatureLockDialog';
import { isLocked, isUnlocked, unlockFeature } from '../apps/web/src/lib/feature-flags';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('feature acknowledgment gate', () => {
  it('locks protected features until the browser acknowledges them', () => {
    expect(isLocked('transcription')).toBe(true);
    expect(isUnlocked('transcription')).toBe(false);

    unlockFeature('transcription');

    expect(isLocked('transcription')).toBe(false);
    expect(isUnlocked('transcription')).toBe(true);
    // The storage key is unchanged so previously unlocked browsers keep access.
    expect(localStorage.getItem('wishly.feature-unlock.transcription')).toBe('true');
  });

  it('notifies listeners when a feature is acknowledged', () => {
    const listener = vi.fn();
    window.addEventListener('wishly-feature-unlock', listener);
    unlockFeature('transcription');
    window.removeEventListener('wishly-feature-unlock', listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('FeatureLockDialog', () => {
  it('warns about the work-in-progress feature and unlocks it on confirmation', async () => {
    const onUnlocked = vi.fn();
    const onClose = vi.fn();
    render(<FeatureLockDialog feature="transcription" onUnlocked={onUnlocked} onClose={onClose} />);

    expect(screen.getByRole('heading', { name: 'Still under construction' })).toBeTruthy();
    expect(screen.getByText(/at your own risk/)).toBeTruthy();
    expect(screen.getByText(/processed locally/)).toBeTruthy();
    // The developer pass form is gone.
    expect(document.querySelector('input')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Got it, open the tool' }));

    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(isUnlocked('transcription')).toBe(true);
  });

  it('keeps the feature locked when the user declines', async () => {
    const onUnlocked = vi.fn();
    const onClose = vi.fn();
    render(<FeatureLockDialog feature="transcription" onUnlocked={onUnlocked} onClose={onClose} />);

    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(isUnlocked('transcription')).toBe(false);
    expect(localStorage.getItem('wishly.feature-unlock.transcription')).toBeNull();
  });
});
