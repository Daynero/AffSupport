import { useEffect, useRef, useState, type CSSProperties } from 'react';

const LABELS = [
  'Стискай швидше',
  'Оптимізуй легко',
  'Транскрибуй локально',
  'Переглядай миттєво',
  'Автоматизуй рутину',
  'Обробляй безпечно',
  'Заощаджуй час',
  'Працюй командою',
  'Упорядковуй медіа',
  'Створюй більше'
] as const;

const SPAWN_POINTS = [
  { x: 12, y: 18 },
  { x: 35, y: 13 },
  { x: 64, y: 14 },
  { x: 87, y: 20 },
  { x: 14, y: 43 },
  { x: 86, y: 45 },
  { x: 12, y: 70 },
  { x: 35, y: 82 },
  { x: 65, y: 82 },
  { x: 88, y: 70 }
] as const;

const ANIMATION_MS = 7200;
const SPAWN_INTERVAL_MS = 2700;
const MIN_POINT_DISTANCE = 38;

type AmbientLabel = {
  id: number;
  label: string;
  point: (typeof SPAWN_POINTS)[number];
};

function shuffledLabels() {
  const pool = [...LABELS];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool;
}

function distance(first: (typeof SPAWN_POINTS)[number], second: (typeof SPAWN_POINTS)[number]) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function PublicAmbientLabels() {
  const [active, setActive] = useState<AmbientLabel[]>([]);
  const bag = useRef<string[]>([]);
  const activePoints = useRef<AmbientLabel['point'][]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const removalTimers = new Set<number>();

    const spawn = () => {
      if (bag.current.length === 0) bag.current = shuffledLabels();

      const availablePoints = SPAWN_POINTS.filter(point =>
        activePoints.current.every(
          activePoint => distance(point, activePoint) >= MIN_POINT_DISTANCE
        )
      );
      const candidates = availablePoints.length > 0 ? availablePoints : [...SPAWN_POINTS];
      const point = candidates[Math.floor(Math.random() * candidates.length)];
      const item: AmbientLabel = {
        id: nextId.current++,
        label: bag.current.shift()!,
        point
      };

      activePoints.current = [...activePoints.current, point].slice(-3);
      setActive(current => [...current, item].slice(-3));

      const timer = window.setTimeout(() => {
        activePoints.current = activePoints.current.filter(activePoint => activePoint !== point);
        setActive(current => current.filter(candidate => candidate.id !== item.id));
        removalTimers.delete(timer);
      }, ANIMATION_MS);
      removalTimers.add(timer);
    };

    const firstSpawn = window.setTimeout(spawn, 650);
    const interval = window.setInterval(spawn, SPAWN_INTERVAL_MS);

    return () => {
      window.clearTimeout(firstSpawn);
      window.clearInterval(interval);
      removalTimers.forEach(timer => window.clearTimeout(timer));
      activePoints.current = [];
    };
  }, []);

  return (
    <div className="public-ambient-labels" aria-hidden="true">
      {active.map(item => (
        <span
          className="public-ambient-label"
          key={item.id}
          style={
            {
              '--ambient-x': `${item.point.x}%`,
              '--ambient-y': `${item.point.y}%`,
              '--ambient-duration': `${ANIMATION_MS}ms`
            } as CSSProperties
          }
        >
          {item.label}
        </span>
      ))}
    </div>
  );
}
