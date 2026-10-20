// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Slider, RadioGroup } from '../apps/web/src/components/ui/Choice';
afterEach(cleanup);
it('edits each range endpoint by keyboard and reports settled ordered values', async () => {
  const changed = vi.fn();
  const settled = vi.fn();
  function Range() {
    const [range, setRange] = React.useState<readonly [number, number]>([20, 80]);
    return (
      <Slider
        aria-label="Duration range"
        min={0}
        max={100}
        step={5}
        rangeValue={range}
        onRangeChange={next => {
          setRange(next);
          changed(next);
        }}
        onRangeChangeEnd={settled}
      />
    );
  }
  render(<Range />);
  const user = userEvent.setup();
  const [lower, upper] = screen.getAllByRole('slider');
  if (!lower || !upper) throw new Error('Expected two range endpoints');
  lower.focus();
  await user.keyboard('{ArrowRight}');
  expect(changed).toHaveBeenLastCalledWith([25, 80]);
  expect(settled).toHaveBeenLastCalledWith([25, 80]);
  upper.focus();
  await user.keyboard('{ArrowLeft}');
  expect(changed).toHaveBeenLastCalledWith([25, 75]);
  expect(settled).toHaveBeenLastCalledWith([25, 75]);
  expect(lower).toHaveProperty('value', '25');
  expect(upper).toHaveProperty('value', '75');
});
it('offers the list radio icon and description while disabled options remain unselectable', async () => {
  const change = vi.fn();
  render(
    <RadioGroup
      label="Delivery mode"
      value="safe"
      onChange={change}
      options={[
        { value: 'safe', label: 'Safe', icon: <span>✓</span>, description: 'Keeps original media' },
        { value: 'fast', label: 'Fast', disabled: true }
      ]}
    />
  );
  const user = userEvent.setup();
  expect(screen.getByText('Keeps original media')).toBeTruthy();
  expect(screen.getByRole('radio', { name: /Safe/ })).toHaveProperty('checked', true);
  await user.click(screen.getByRole('radio', { name: 'Fast' }));
  expect(change).not.toHaveBeenCalled();
});
