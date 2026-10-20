import { CollisionPriority, CollisionType, type CollisionDetector } from '@dnd-kit/abstract';

/** Target the complete row's center, independently of the pointer's grab offset. */
export const accountCenterCollision: CollisionDetector = ({ dragOperation, droppable }) => {
  const source = dragOperation.shape?.current;
  const target = droppable.shape;
  if (!source || !target) return null;
  const distance = Math.hypot(source.center.x - target.center.x, source.center.y - target.center.y);
  return {
    id: droppable.id,
    value: distance === 0 ? Number.POSITIVE_INFINITY : 1 / distance,
    type: CollisionType.Collision,
    priority: CollisionPriority.Normal
  };
};
