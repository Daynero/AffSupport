// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { afterAccountDrop } from '../apps/web/src/team/accounts/afterAccountDrop';

afterEach(() => {
  document.body.replaceChildren();
});
function source() {
  const table = document.createElement('div');
  table.className = 'team-accounts-table';
  const element = document.createElement('section');
  element.setAttribute('data-dnd-dragging', '');
  element.setAttribute('popover', 'manual');
  table.append(element);
  document.body.append(table);
  return { table, element };
}
it('keeps expanded content folded throughout Feedback dropping and restores after its fixed box is released', async () => {
  const { element } = source();
  const restore = vi.fn();
  afterAccountDrop(element, restore);
  expect(restore).not.toHaveBeenCalled();
  element.removeAttribute('data-dnd-dragging');
  element.setAttribute('data-dnd-dropping', '');
  await Promise.resolve();
  expect(restore).not.toHaveBeenCalled();
  element.removeAttribute('popover');
  await Promise.resolve();
  expect(restore).not.toHaveBeenCalled();
  element.removeAttribute('data-dnd-dropping');
  await Promise.resolve();
  expect(restore).toHaveBeenCalledTimes(1);
  element.setAttribute('style', '');
  await Promise.resolve();
  expect(restore).toHaveBeenCalledTimes(1);
});
it('releases the folding guard when a dragged social is removed by a membership update', async () => {
  const { element } = source();
  const restore = vi.fn();
  afterAccountDrop(element, restore);
  element.remove();
  await Promise.resolve();
  expect(restore).toHaveBeenCalledTimes(1);
});
it('does not restore state after the provider is disposed', async () => {
  const { element } = source();
  const restore = vi.fn();
  const dispose = afterAccountDrop(element, restore);
  dispose();
  element.remove();
  await Promise.resolve();
  expect(restore).not.toHaveBeenCalled();
});
it('restores immediately when no Feedback surface was created', () => {
  const restore = vi.fn();
  afterAccountDrop(undefined, restore);
  expect(restore).toHaveBeenCalledTimes(1);
});
