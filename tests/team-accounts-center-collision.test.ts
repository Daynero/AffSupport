import { expect, it } from 'vitest';
import { sortCollisions, type CollisionDetector } from '@dnd-kit/abstract';
import { accountCenterCollision } from '../apps/web/src/team/accounts/accountCollision';

type Rect = { top: number; height: number };
const center = ({ top, height }: Rect) => ({ x: 100, y: top + height / 2 });

function collision(source: Rect | null, target: Rect | null, id: string, pointerY: number) {
  return accountCenterCollision({
    dragOperation: {
      shape: source ? { current: { center: center(source) } } : undefined,
      position: { current: { x: 100, y: pointerY }, direction: null }
    },
    droppable: { id, shape: target ? { center: center(target) } : undefined }
  } as unknown as Parameters<CollisionDetector>[0]);
}

function winner(source: Rect, targets: Record<string, Rect>, pointerY: number) {
  return Object.entries(targets)
    .map(([id, target]) => collision(source, target, id, pointerY))
    .filter(result => result !== null)
    .sort(sortCollisions)[0]?.id;
}

it('swaps a tall RK at equal center-distance boundaries in mirrored up/down layouts', () => {
  // A 200px source and adjacent 44px sibling have centers 122px apart.
  const down = { source: { top: 0, height: 200 }, neighbor: { top: 200, height: 44 } };
  const up = { source: { top: 44, height: 200 }, neighbor: { top: 0, height: 44 } };
  expect(winner({ top: 60, height: 200 }, down, 65)).toBe('source');
  expect(winner({ top: 62, height: 200 }, down, 67)).toBe('neighbor');
  expect(winner({ top: -16, height: 200 }, up, 179)).toBe('source');
  expect(winner({ top: -18, height: 200 }, up, 177)).toBe('neighbor');
});

it('keeps the same target for top and bottom grab points, including null movement direction', () => {
  const targets = { source: { top: 0, height: 200 }, neighbor: { top: 200, height: 44 } };
  const moved = { top: 62, height: 200 };
  expect(winner(moved, targets, 67)).toBe('neighbor');
  expect(winner(moved, targets, 257)).toBe('neighbor');
});

it('keeps an exactly centered source ahead of any finite-distance sibling', () => {
  const source = { top: 0, height: 200 };
  expect(winner(source, { source, neighbor: { top: 200, height: 44 } }, 199)).toBe('source');
});

it('does not manufacture a pointer collision when a measured shape is missing', () => {
  const row = { top: 0, height: 200 };
  expect(collision(null, row, 'target', 100)).toBeNull();
  expect(collision(row, null, 'target', 100)).toBeNull();
});
