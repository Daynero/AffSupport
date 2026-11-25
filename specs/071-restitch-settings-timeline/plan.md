# Implementation Plan: Перезашивка як стрічка ролика

**Spec**: [spec.md](spec.md) · **Branch**: `070-explorer-cabinet-polish` → `integration/1.6-polish`

## Summary

Розділ «Перезашивка» налаштувань простору перестає монтувати інструментальний
`ImageEmbeddingSection` і отримує власну композицію: речення «навіщо» → стрічка ролика
(інвентарний `RestitchTimeline`) → панель обраного сегмента → «як картинка ляже в кадр» →
«Зберегти» → блок підготовки матеріалів (без змін). Вибір операції зникає; збереження пише
`restitch`. Бекенд, агент і `StitcherPage` не змінюються; вбудовані картинки — за контрактом
агента захисту (findings.md).

## Technical Context

- React 19 + HeroUI v3 інвентар (`apps/web/src/components/ui`), токени `styles/tokens.css`.
- Дані: `TeamRestitchDefaults` (форма), `RestitchSourcesListing` (пули) — як у 030.
- Мініатюри файлів: `useThumbnailSession` + `client.thumbnailUrl` (провідник), `FadeImage`.
- Тести: vitest jsdom, single-worker.

## Структура

```
apps/web/src/components/ui/RestitchTimeline.tsx        # стрічка: сегменти, розрив осі, шкала, ручка-slider
apps/web/src/components/ui/restitch-timeline-scale.ts  # чиста модель: хвилини ↔ режим, прив'язка, підписи
apps/web/src/components/ui/index.ts                    # експорт
apps/web/src/styles/restitch-timeline.css              # стилі стрічки (лише токени), імпорт у styles/index.css
apps/web/src/team/workspace/restitch/restitch-form.ts  # форма простору, builtinSlot(), хвилини фіналу
apps/web/src/team/workspace/restitch/RestitchSlotPanel.tsx  # панель слота: перемикач, пул, тривалість старту
apps/web/src/team/workspace/restitch/RestitchFitPicker.tsx  # три кадри «як ляже»
apps/web/src/team/workspace/RestitchDefaultsSection.tsx     # композиція, без режимів
apps/web/src/team/workspace/space-settings.css              # компонування розділу
apps/web/src/team/workspace/restitch/restitch-row.ts   # сирий рядок простору (get_restitch_defaults)
apps/web/src/locales/{uk,en}.ts
tests/restitch-timeline.test.tsx, tests/team-restitch-section.test.tsx (оновлено)
```

## Ключові рішення

Див. spec.md «Рішення, прийняті без власника» (R1–R7). Коротко про шкалу: ширина стрічки =
блок початку (стала) + блок відео (стала частка) + розрив + фінал. Фінал займає решту, і
його внутрішня шкала лінійна 0–60 хв; значення `m` малює заповнення `m/60` цієї частини.
У режимі «щоразу різна» заповнення до нижньої межі суцільне, а від нижньої до верхньої —
заштрихована зона «десь тут»; ручка стоїть на верхній межі.

## Ризики

- Інші агенти паралельно правлять `locales/uk.ts`/`en.ts` — комітити лише свої рядки
  (`git apply --cached` власного патча).
- Вбудовані картинки: контракт агента захисту (findings.md). До релізу агента, що вбудує PNG,
  сервер для старих агентів пропускає стандартний початок і ставить останній кадр відео замість
  стандартного фіналу — UI показує задумане (стандартну картинку), а не цю тимчасову сумісність.
