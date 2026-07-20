// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LandingAsset, LandingJob } from '../packages/shared/src/types.js';
import { LandingJobCard, landingJobProgress } from '../apps/web/src/landing/LandingJobCard';
import { translate } from '../apps/web/src/i18n';
import type { Translate } from '../apps/web/src/components/ui';

const t: Translate = (key, values) => translate('en', key, values);

afterEach(cleanup);

describe('landing optimizer batch card', () => {
  it('shows one collapsed landing card and reveals the complete file list on demand', async () => {
    const user = userEvent.setup();
    const job = makeJob('ready', [
      asset('hero.jpg', 'pending'),
      asset('intro.mp4', 'pending', 'video')
    ]);
    renderCard(job);

    expect(screen.getByText('promo-landing')).toBeTruthy();
    expect(screen.queryByText('hero.jpg')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show all files: promo-landing' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await user.click(toggle);
    expect(screen.getByText('hero.jpg')).toBeTruthy();
    expect(screen.getByText('intro.mp4')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('hero.jpg').closest('.collapse')?.getAttribute('aria-hidden')).toBe(
      'true'
    );
  });

  it('opens an accessible before/after comparison and supports keyboard control', async () => {
    const user = userEvent.setup();
    const image = asset('hero.jpg', 'optimized');
    image.optimizedSize = 400;
    image.savedBytes = 600;
    image.savedPercent = 60;
    image.newRelPath = 'images/hero.webp';
    image.preview = { available: true, comparison: true, width: 1200, height: 800 };
    const job = makeJob('completed', [image]);
    renderCard(job);

    await user.click(screen.getByRole('button', { name: 'Show all files: promo-landing' }));
    const previewButton = screen.getByRole('button', {
      name: 'Compare before and after for hero.jpg'
    });
    expect(previewButton.classList.contains('landing-preview-thumbnail')).toBe(true);
    expect(previewButton.classList.contains('is-comparison')).toBe(true);
    await user.click(previewButton);

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    for (const imageElement of Array.from(dialog.querySelectorAll('img'))) {
      fireEvent.load(imageElement);
    }
    const slider = screen.getByRole('slider', { name: 'Before and after divider' });
    fireEvent.change(slider, { target: { value: '73' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('73%');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(previewButton);
  });

  it('opens one image without a comparison slider when the original was kept', async () => {
    const user = userEvent.setup();
    const image = asset('hero.jpg', 'skipped');
    image.optimizedSize = image.originalSize;
    image.savedBytes = 0;
    image.savedPercent = 0;
    image.preview = { available: true, comparison: false, width: 900, height: 900 };
    const job = makeJob('completed', [image]);
    renderCard(job);

    await user.click(screen.getByRole('button', { name: 'Show all files: promo-landing' }));
    const previewButton = screen.getByRole('button', { name: 'Open preview for hero.jpg' });
    expect(previewButton.classList.contains('landing-preview-thumbnail')).toBe(true);
    expect(previewButton.classList.contains('is-single')).toBe(true);
    await user.click(previewButton);

    const dialog = screen.getByRole('dialog');
    const images = dialog.querySelectorAll('img');
    expect(images).toHaveLength(1);
    fireEvent.load(images[0]);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText('This image was kept without changes')).toBeTruthy();
  });

  it('uses the authoritative end-to-end progress supplied by the agent', () => {
    const processing = makeJob('processing', [asset('hero.jpg', 'optimized')]);
    processing.progress = 96;
    processing.phase = 'packaging';
    expect(landingJobProgress(processing)).toBe(96);

    const completed = makeJob('completed', [asset('hero.jpg', 'optimized')]);
    completed.progress = 88;
    expect(landingJobProgress(completed)).toBe(100);
  });

  it('shows a queued landing as waiting and lets it be discarded', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    const job = makeJob('queued', [asset('hero.jpg', 'pending')]);
    render(
      <LandingJobCard
        job={job}
        connected
        running={false}
        language="en"
        onStart={vi.fn()}
        onReset={onReset}
        onReveal={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('Waiting in queue…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Optimize landing' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onReset).toHaveBeenCalledOnce();
  });
});

function renderCard(job: LandingJob) {
  return render(
    <LandingJobCard
      job={job}
      connected
      running={job.status === 'processing'}
      language="en"
      onStart={vi.fn()}
      onReset={vi.fn()}
      onReveal={vi.fn()}
      t={t}
    />
  );
}

function makeJob(status: LandingJob['status'], assets: LandingAsset[]): LandingJob {
  const completed = assets.filter(item =>
    ['optimized', 'skipped', 'failed'].includes(item.status)
  ).length;
  const originalMediaSize = assets.reduce((total, item) => total + item.originalSize, 0);
  const optimizedMediaSize = assets.reduce(
    (total, item) => total + (item.optimizedSize ?? item.originalSize),
    0
  );
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'promo-landing',
    sourceKind: 'zip',
    status,
    phase: status === 'completed' ? 'completed' : status === 'processing' ? 'optimizing' : status,
    progress: status === 'completed' ? 100 : status === 'preparing' ? null : 0,
    completedAssets: completed,
    totalAssets: assets.length,
    currentAssetId: assets.find(item => item.status === 'processing')?.id ?? null,
    settings: { imageQuality: 'optimal', videoQuality: 'optimal', archive: true },
    assets,
    imagesOptimized: assets.filter(item => item.type === 'image' && item.status === 'optimized')
      .length,
    videosOptimized: assets.filter(item => item.type === 'video' && item.status === 'optimized')
      .length,
    filesSkipped: assets.filter(item => item.status === 'skipped').length,
    filesFailed: assets.filter(item => item.status === 'failed').length,
    referencesUpdated: 1,
    originalMediaSize,
    optimizedMediaSize,
    savedBytes: Math.max(0, originalMediaSize - optimizedMediaSize),
    savedPercent: originalMediaSize
      ? Math.round(((originalMediaSize - optimizedMediaSize) / originalMediaSize) * 100)
      : 0,
    outputPath: status === 'completed' ? '/tmp/promo-landing-optimized.zip' : null,
    outputIsArchive: true,
    error: null,
    warnings: [],
    createdAt: 1,
    startedAt: status === 'ready' ? null : 2,
    finishedAt: status === 'completed' ? 3 : null
  };
}

function asset(
  fileName: string,
  status: LandingAsset['status'],
  type: LandingAsset['type'] = 'image'
): LandingAsset {
  return {
    id: fileName === 'hero.jpg' ? '22222222-2222-4222-8222-222222222222' : crypto.randomUUID(),
    relPath: `images/${fileName}`,
    fileName,
    type,
    status,
    originalSize: 1_000,
    optimizedSize: status === 'optimized' ? 500 : null,
    savedBytes: status === 'optimized' ? 500 : null,
    savedPercent: status === 'optimized' ? 50 : null,
    progress: status === 'processing' ? 25 : null,
    newRelPath: null,
    note: null,
    preview: null
  };
}
