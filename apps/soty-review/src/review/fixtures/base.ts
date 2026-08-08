import type { DemoItem } from '../model';

export const demoPeople = ['Олена Коваль', 'Марко Левченко', 'Софія Бондар'] as const;
export const demoFiles = [
  'summer-campaign-hero-v12.mp4',
  'інтервʼю-з-командою-фінальна-версія.mov',
  'extremely-long-localized-campaign-file-name-for-responsive-review.webm'
] as const;

export const demoItems: readonly DemoItem[] = [
  { id: 'creative-01', title: demoFiles[0], detail: '24 MB · готово', status: 'ready' },
  { id: 'creative-02', title: demoFiles[1], detail: 'Обробка · 64%', status: 'active' },
  { id: 'creative-03', title: demoFiles[2], detail: 'Потребує уваги', status: 'warning' }
];

export const emptyItems: readonly DemoItem[] = [];
