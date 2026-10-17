// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DurationSlider,
  moveDurationSelection
} from '../apps/web/src/components/ui/DurationSlider';
import { launchConfig, launchSources } from './fixtures/launches';
import {
  launchPreview,
  launchRevisionImpact,
  parseLaunchConfig,
  parseLaunchDraft
} from '../packages/shared/src/team/launches';
afterEach(cleanup);
it('moves the whole window and clamps it without shrinking at either boundary', () => {
  expect(moveDurationSelection([25, 35], 50)).toEqual([50, 60]);
  expect(moveDurationSelection([25, 35], -50)).toEqual([1, 11]);
  expect(moveDurationSelection([25, 35], 4)).toEqual([29, 39]);
});
it('edits edges independently and commits only once after a drag', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const commit = vi.fn();
  const view = render(
    <DurationSlider value={[25, 35]} range label="Duration" unit="min" onCommit={commit} />
  );
  const track = view.container.querySelector('.duration-slider-track')! as HTMLDivElement;
  track.setPointerCapture = vi.fn();
  track.releasePointerCapture = vi.fn();
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 590 } as DOMRect);
  fireEvent.pointerDown(screen.getAllByRole('slider')[0], { clientX: 240, button: 0 });
  fireEvent.pointerMove(track, { clientX: 200, buttons: 1 });
  expect(screen.getAllByRole('slider')[0].getAttribute('aria-valuenow')).toBe('21');
  expect(screen.getAllByRole('slider')[1].getAttribute('aria-valuenow')).toBe('35');
  expect(commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(track);
  expect(commit).toHaveBeenCalledExactlyOnceWith([21, 35]);
  fireEvent.pointerDown(view.container.querySelector('[data-part="range"]')!, {
    clientX: 250,
    button: 0
  });
  fireEvent.pointerMove(track, { clientX: 300, buttons: 1 });
  fireEvent.pointerUp(track);
  expect(commit).toHaveBeenLastCalledWith([26, 40]);
  vi.unstubAllGlobals();
});
it('exposes one accessible thumb and no fill for exact time, with keyboard support', () => {
  const commit = vi.fn();
  const view = render(
    <DurationSlider value={[30, 0]} range={false} label="Duration" unit="min" onCommit={commit} />
  );
  expect(screen.getAllByRole('slider')).toHaveLength(1);
  expect(view.container.querySelector('.duration-slider-selection')).toBeNull();
  fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
  expect(commit).toHaveBeenLastCalledWith([31, 0]);
});
it('round trips arbitrary bounds and marks a bounds-only edit as a media change', () => {
  const before = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'random-centered',
      customFinalDurationSeconds: 1800,
      finalDurationRangeSeconds: [1200, 2400]
    }
  });
  const after = {
    ...before,
    catalog: { ...before.catalog, finalDurationRangeSeconds: [1500, 2100] as const }
  };
  expect(parseLaunchConfig(after)).toMatchObject({
    ok: true,
    value: { catalog: { finalDurationRangeSeconds: [1500, 2100] } }
  });
  expect(parseLaunchDraft({ catalog: after.catalog })?.catalog?.finalDurationRangeSeconds).toEqual([
    1500, 2100
  ]);
  const preview = launchPreview(before, launchSources);
  if (!preview.ok) throw new Error('fixture');
  expect(launchRevisionImpact(preview.value, preview.value, before, after).mediaChanged).toBe(true);
  expect(
    parseLaunchConfig({
      ...after,
      catalog: { ...after.catalog, finalDurationRangeSeconds: [2400, 1200] }
    }).ok
  ).toBe(false);
});
it('animates a split at the upper boundary and respects reduced motion', () => {
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
    cancel: vi.fn()
  }));
  const original = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = animate as unknown as typeof original;
  const media = vi.fn(() => ({ matches: false }));
  vi.stubGlobal('matchMedia', media);
  try {
    const view = render(
      <DurationSlider
        value={[60, 0]}
        range={false}
        label="Duration"
        unit="min"
        onCommit={vi.fn()}
      />
    );
    const track = view.container.querySelector('.duration-slider-track')!;
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ width: 590 } as DOMRect);
    view.rerender(
      <DurationSlider value={[55, 60]} range label="Duration" unit="min" onCommit={vi.fn()} />
    );
    expect(screen.getAllByRole('slider').map(el => el.getAttribute('aria-valuenow'))).toEqual([
      '55',
      '60'
    ]);
    expect(animate.mock.calls[0][0][0].translate).toBe('50px 0');
    expect(animate.mock.calls[1][0][0].translate).toBe('0px 0');
    media.mockReturnValue({ matches: true });
    animate.mockClear();
    view.rerender(
      <DurationSlider
        value={[58, 0]}
        range={false}
        label="Duration"
        unit="min"
        onCommit={vi.fn()}
      />
    );
    expect(animate).not.toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.animate = original;
    vi.unstubAllGlobals();
  }
});
it('slides the mode action away from the minutes badge without bouncing in the middle', () => {
  const props = {
    range: true,
    label: 'Duration',
    unit: 'min',
    onCommit: vi.fn(),
    modeAction: <button>Exact time</button>
  };
  const view = render(<DurationSlider {...props} value={[25, 35]} />);
  const root = view.container.querySelector('.duration-slider')! as HTMLElement;
  const badge = view.container.querySelector('.duration-slider-value')! as HTMLElement;
  const action = view.container.querySelector('.duration-slider-mode')! as HTMLElement;
  vi.spyOn(root, 'clientWidth', 'get').mockReturnValue(324);
  vi.spyOn(badge, 'offsetWidth', 'get').mockReturnValue(90);
  vi.spyOn(action, 'offsetWidth', 'get').mockReturnValue(80);
  view.rerender(<DurationSlider {...props} value={[26, 36]} />);
  expect(action.style.transform).toBe('translateX(244px)');
  view.rerender(<DurationSlider {...props} value={[50, 60]} />);
  expect(action.style.transform).toBe('translateX(0px)');
  view.rerender(<DurationSlider {...props} value={[25, 35]} />);
  expect(action.style.transform).toBe('translateX(0px)');
  view.rerender(<DurationSlider {...props} value={[1, 11]} />);
  expect(action.style.transform).toBe('translateX(244px)');
});

it.each(['outside release', 'lost capture', 'window blur', 'missed release'])(
  'stops dragging after %s and commits once',
  reason => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    try {
      const commit = vi.fn();
      const view = render(
        <DurationSlider value={[25, 35]} range label="Duration" unit="min" onCommit={commit} />
      );
      const track = view.container.querySelector('.duration-slider-track')! as HTMLDivElement;
      track.setPointerCapture = vi.fn();
      track.hasPointerCapture = vi.fn(() => true);
      track.releasePointerCapture = vi.fn();
      vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 590 } as DOMRect);
      fireEvent.pointerDown(screen.getAllByRole('slider')[0], {
        clientX: 240,
        button: 0,
        buttons: 1
      });
      fireEvent.pointerMove(track, { clientX: 200, buttons: 1 });
      if (reason === 'outside release') fireEvent.pointerUp(window);
      if (reason === 'lost capture') fireEvent.lostPointerCapture(track);
      if (reason === 'window blur') fireEvent.blur(window);
      if (reason === 'missed release') fireEvent.pointerMove(track, { clientX: 150, buttons: 0 });
      fireEvent.pointerMove(track, { clientX: 100, buttons: 0 });
      fireEvent.pointerUp(track);
      expect(screen.getAllByRole('slider')[0].getAttribute('aria-valuenow')).toBe('21');
      expect(commit).toHaveBeenCalledExactlyOnceWith([21, 35]);
    } finally {
      vi.unstubAllGlobals();
    }
  }
);
it('cancels a pointer gesture without retaining a drag or committing it', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  try {
    const commit = vi.fn();
    const view = render(
      <DurationSlider value={[25, 35]} range label="Duration" unit="min" onCommit={commit} />
    );
    const track = view.container.querySelector('.duration-slider-track')! as HTMLDivElement;
    track.setPointerCapture = vi.fn();
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 590 } as DOMRect);
    fireEvent.pointerDown(screen.getAllByRole('slider')[0], {
      clientX: 240,
      button: 0,
      buttons: 1
    });
    fireEvent.pointerMove(track, { clientX: 200, buttons: 1 });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(track, { clientX: 100, buttons: 0 });
    expect(screen.getAllByRole('slider')[0].getAttribute('aria-valuenow')).toBe('25');
    expect(commit).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
