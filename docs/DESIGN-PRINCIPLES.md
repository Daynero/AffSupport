# Правила дизайна

Свод правил по UI, UX и анимациям. Источники:
- [uidesign.tips](https://www.uidesign.tips/) (Jim Raptis) — база по UI/UX
- [animations.dev](https://animations.dev/) и [emilkowal.ski](https://emilkowal.ski/) (Emil Kowalski) — правила анимаций

---

## UI

### Кнопки и CTA

- **Всегда добавляй CTA** — размещай возможности конверсии выше первого экрана для тех, кто не скроллит. ([source](https://www.uidesign.tips/ui-tips/hero-section-cta-1))
- **Используй консистентные кнопки** — особенно в шапке, поддерживай единый стиль кнопок по всему интерфейсу. ([source](https://www.uidesign.tips/ui-tips/hero-section-consistency))
- **Делай ссылки кнопками** — для не-текстовых ссылок используй стиль кнопки и actionable-копирайт. ([source](https://www.uidesign.tips/ui-tips/engaging-links))
- **Де-эмфасируй опасные действия** — приоритезируй безопасные действия над необратимыми с помощью нескольких визуальных признаков (цвет, размер, вес). ([source](https://www.uidesign.tips/ui-tips/de-emphasize-dangerous-actions))
- **Подтверждай удаление** — требуй подтверждения для необратимых действий, давай возможность откатить (undo). ([source](https://www.uidesign.tips/ui-tips/how-to-validate-deletion))
- **Описательный текст в модалках удаления** — вместо «Yes / No» пиши осмысленные глаголы действия. ([source](https://www.uidesign.tips/ui-tips/quick-ui-fixes))

### Иерархия и фокус внимания

- **Принцип Гутенберга** — глаз движется по Z-паттерну; ставь CTA в конце этого естественного потока. ([source](https://www.uidesign.tips/ui-tips/gutenburg-principle))
- **Хакни визуальную иерархию** — снижение opacity, жирный шрифт, соотношения размеров, группировка элементов. ([source](https://www.uidesign.tips/ui-tips/visual-hierarchy))
- **Усиливай иерархию** — приоритезируй основной CTA, играй атрибутами текста для привлечения внимания. ([source](https://www.uidesign.tips/ui-tips/quick-ui-fixes-1))
- **Направляй внимание медиа** — используй визуальное направление (взгляд, указатели), чтобы сфокусировать внимание на ключевых элементах. ([source](https://www.uidesign.tips/ui-tips/hero-section-cta-2))
- **Подсказывай скролл** — показывай кусочек следующей секции, чтобы стимулировать скроллинг. ([source](https://www.uidesign.tips/ui-tips/hero-section-prompt-scroll))
- **Выделяй лучший оффер** — подсвечивай топовый план в pricing с помощью нескольких приёмов одновременно. ([source](https://www.uidesign.tips/ui-tips/highlight-popular-plan))

### Формы и инпуты

- **Делай инпуты самообъясняющимися** — используй placeholder-текст по делу и подходящий тип input. ([source](https://www.uidesign.tips/ui-tips/make-inputs-self-explanatory))
- **Выбирай правильный элемент** — для чисел используй number picker вместо обычного текстового поля. ([source](https://www.uidesign.tips/ui-tips/number-input-1))
- **Используй labels умно** — на color picker'ах добавляй текстовые лейблы для color-blind пользователей. ([source](https://www.uidesign.tips/ui-tips/use-labels-cleverly-2))
- **Дополняй ссылки визуалом** — рядом с текстом ссылки показывай визуальное представление выбора. ([source](https://www.uidesign.tips/ui-tips/use-labels-cleverly))

### Меню и навигация

- **Дизайн меню** — добавляй иконки рядом с пунктами и подсвечивай активный таб. ([source](https://www.uidesign.tips/ui-tips/better-menus))
- **Идеальный header** — играй font-weight для иерархии, держи единую шкалу типографики, выравнивай по левому краю. ([source](https://www.uidesign.tips/ui-tips/how-to-design-the-perfect-header))
- **Визуально разделяй элементы** — whitespace и разделители для структурирования секций меню. ([source](https://www.uidesign.tips/ui-tips/visually-seperate-elements-1))

### Цвет, форма, бордеры

- **Применяй брендовый цвет точечно** — подсвечивай только критичные элементы, для второстепенных используй tints/shades. ([source](https://www.uidesign.tips/ui-tips/brand-colors))
- **Консистентный border-radius** — формула: внешний radius = 2 × внутренний radius. ([source](https://www.uidesign.tips/ui-tips/border-radius-consistency))
- **Padding на скруглённых карточках** — на не-скруглённых краях удваивай padding для визуального баланса. ([source](https://www.uidesign.tips/ui-tips/round-card-padding))
- **Fallback для прозрачных аватаров** — добавляй тонкий бордер и фоновый цвет PNG-аватарам. ([source](https://www.uidesign.tips/ui-tips/avatar-background-1))
- **Бордер под фон** — для прозрачных аватаров используй бордер в тон фону, чтобы отделить от контейнера. ([source](https://www.uidesign.tips/ui-tips/avatar-background-2))

### Состояния

- **Различай выбранные элементы** — меняй фон, чтобы выбор был сразу заметен. ([source](https://www.uidesign.tips/ui-tips/distinguish-selected-items))
- **Empty state с шаблонами** — давай готовые шаблоны для ускорения онбординга. ([source](https://www.uidesign.tips/ui-tips/empty-state))
- **Карточки должны выглядеть кликабельными** — добавляй явный CTA-баттон, чтобы было понятно, что карточка интерактивна. ([source](https://www.uidesign.tips/ui-tips/make-cards-look-clickable-vol-2))

### Типографика и читаемость

- **Не делай абзацы во всю ширину** — ограничивай длину строки 500–700px или используй CSS-единицу `ch`. ([source](https://www.uidesign.tips/ui-tips/line-width))

### Выравнивание

- **Выравнивай неровные элементы** — задавай одинаковую ширину по самому большому элементу. ([source](https://www.uidesign.tips/ui-tips/align-unever-items))

### Иконки и подсказки

- **Подкрепляй иконки текстом** — комбинируй иконку с текстовой подписью для ясности. ([source](https://www.uidesign.tips/ui-tips/support-icons-with-text))
- **Адаптивные tooltips** — на мобилках добавляй кликабельную help-иконку, т.к. hover недоступен. ([source](https://www.uidesign.tips/ui-tips/responsive-tooltips))
- **Показывай горячие клавиши** — размещай шорткаты рядом с кнопками действия (закон Фиттса). ([source](https://www.uidesign.tips/ui-tips/users-hate-surprises-1))

### Графики и данные

- **Выбирай тип графика осознанно** — для ограниченного набора значений по X используй bar chart, не line chart. ([source](https://www.uidesign.tips/ui-tips/right-chart-type))

### Доступность

- **Различай элементы несколькими способами** — комбинируй форму, цвет, текст и иконки (доступность для color-blind). ([source](https://www.uidesign.tips/ui-tips/social-login))

---

## UX

### Конверсии и CTA

- **Текст CTA имеет значение** — конкретный глагол + ценность вместо «Submit / Sign up». ([source](https://www.uidesign.tips/ux-tips/cta-copy-matters))
- **Адаптируй CTA в шапке** — меняй CTA в зависимости от состояния пользователя (залогинен/нет, страница). ([source](https://www.uidesign.tips/ux-tips/adapt-your-header-cta))
- **Покажи ценность рядом с CTA** — превью продукта возле кнопки усиливает мотивацию нажать. ([source](https://www.uidesign.tips/ux-tips/preview-product-value-near-cta))
- **Используй больше цифр** — числа в копирайте конкретизируют ценность и повышают доверие. ([source](https://www.uidesign.tips/ux-tips/use-more-numbers))
- **Калькуляторы ценности** — давай пользователю посчитать выгоду на своих данных. ([source](https://www.uidesign.tips/ux-tips/use-value-calculators))
- **Не давай пользователю гадать** — заранее объясняй следующий шаг, чтобы снять трение. ([source](https://www.uidesign.tips/ui-tips/don-t-let-user-guess))
- **Пользователи не любят сюрпризы** — точные UX-копии о результате действия предотвращают разочарование. ([source](https://www.uidesign.tips/ui-tips/users-hate-surprises))
- **UX важнее конверсий** — не жертвуй общим опытом ради краткосрочной конверсии. ([source](https://www.uidesign.tips/ui-tips/ux-vs-conversions))

### Психология и социальное доказательство

- **Сила лиц** — изображения людей привлекают внимание и повышают доверие. ([source](https://www.uidesign.tips/ux-tips/the-power-of-faces))
- **Направляй взглядом лиц** — взгляд персонажа на CTA → пользователь смотрит туда же. ([source](https://www.uidesign.tips/ux-tips/direct-users-with-faces))
- **Используй социальное доказательство** — отзывы, логотипы клиентов, цифры пользователей. ([source](https://www.uidesign.tips/ux-tips/leverage-social-proof))
- **Отзывы в форме регистрации** — добавь отзыв рядом с signup-формой для снижения трения. ([source](https://www.uidesign.tips/ux-tips/testimonials-signup-form))
- **Красный для важных действий** — используй красный осмысленно, чтобы привлечь внимание к ключевым местам. ([source](https://www.uidesign.tips/ux-tips/use-red-for-important-actions))

### Pricing

- **Различай тарифные планы** — визуально отделяй планы (цвет, размер, бордер). ([source](https://www.uidesign.tips/ux-tips/distinguish-pricingplans))
- **Лучшие тарифные планы** — структурируй pricing с акцентом на рекомендуемом плане. ([source](https://www.uidesign.tips/ux-tips/better-pricing-plans))

### Аутентификация и онбординг

- **Предпочитай Social Auth** — кнопки соцсетей повышают конверсию входа. ([source](https://www.uidesign.tips/ux-tips/prefer-social-auth))
- **Прокачай login screen** — login это не просто форма; добавь визуал, ценность, social proof. ([source](https://www.uidesign.tips/ux-tips/leverage-login-screen))
- **Объясняй разрешения честно** — почему ты просишь доступ и что получит пользователь взамен. ([source](https://www.uidesign.tips/ux-tips/explain-clearly-permissions))
- **Простая миграция** — давай инструменты для импорта данных от конкурентов. ([source](https://www.uidesign.tips/ux-tips/offer-easy-migration))
- **Социальный login на видном месте** — выводи Sign in с Google/Apple наверх, email/password оставляй альтернативой. ([source](https://www.uidesign.tips/ui-tips/social-login))

### Визуалы и контент

- **Покажи ценность визуально** — скриншоты и иллюстрации продают лучше текста. ([source](https://www.uidesign.tips/ux-tips/show-product-value-with-visuals))
- **Используй реальные mockups** — реальные интерфейсы вместо абстрактных стоков. ([source](https://www.uidesign.tips/ux-tips/use-real-mockups))
- **Before / After** — визуальное сравнение «до и после» сильно продаёт ценность. ([source](https://www.uidesign.tips/ux-tips/before-after-visuals))
- **Modal-overlay как подсказка** — модалка-туториал поверх UI, чтобы намекнуть на продукт. ([source](https://www.uidesign.tips/ux-tips/overlay-modal-to-hint-product))
- **Персонализируй контент в демо** — подставляй имя/компанию пользователя в демо-материалы. ([source](https://www.uidesign.tips/ux-tips/personalize-content))
- **Персонализируй контент** — общая персонализация интерфейса повышает вовлечённость. ([source](https://www.uidesign.tips/ux-tips/personalize-content-2))

### Брендинг и тон

- **Используй брендинг** — фирменный стиль в анонсах и коммуникации. ([source](https://www.uidesign.tips/ux-tips/leverage-branding))
- **Милый брендинг работает** — характерные иллюстрации/маскоты делают продукт памятным. ([source](https://www.uidesign.tips/ux-tips/cute-branding-helps))
- **Будь уникальным** — не копируй чужой стиль, ищи свой голос. ([source](https://www.uidesign.tips/ux-tips/be-unique))
- **Будь смешным** — лёгкий юмор в копирайте делает продукт человечным. ([source](https://www.uidesign.tips/ux-tips/be-funny))
- **Easter Eggs** — мелкие приятные сюрпризы создают эмоциональную связь. ([source](https://www.uidesign.tips/ux-tips/easter-egg))

---

## Анимации

Принципы основаны на материалах [animations.dev](https://animations.dev/) и блога [emilkowal.ski](https://emilkowal.ski/) (Emil Kowalski).

### Длительность

- **Держи анимации короткими** — UI-анимации обычно 200–300ms; никогда не дольше 1s (исключение — иллюстративные/декоративные). Длинные анимации убивают ощущение отзывчивости. ([source](https://emilkowal.ski/ui/great-animations))
- **300ms — потолок** — медленнее воспринимается как лаг (180ms dropdown ощущается живым, 400ms — тормозящим). ([source](https://emilkowal.ski/ui/you-dont-need-animations))

### Easing

- **Easing важнее всего остального** — правильная кривая делает движение естественным; неудачный easing убивает даже хорошую анимацию. ([source](https://emilkowal.ski/ui/great-animations))
- **По умолчанию `ease-out`** — для появлений и уходов; ускоряется в начале → ощущается отзывчиво. ([source](https://emilkowal.ski/ui/7-practical-animation-tips))
- **`ease-in-out` для уже видимых элементов** — когда объект на экране и нужно его переместить. ([source](https://emilkowal.ski/ui/great-animations))
- **Избегай встроенных CSS-easing** — `ease-in`, `ease-out`, `ease-in-out` слабоваты; используй кастомные `cubic-bezier()` для энергии и характера. Допустим только `ease` (для ховеров) и `linear`. ([source](https://emilkowal.ski/ui/great-animations))

### Springs и естественность

- **Имитируй физику реального мира** — мгновенные изменения ощущаются искусственно; пользователь лучше понимает изменения, когда они происходят как в реальности. ([source](https://emilkowal.ski/ui/great-animations))
- **Spring для декоративных интеракций** — когда движение — реакция на пользовательский ввод без функциональной цели, spring-интерполяция чувствуется органичнее, чем линейный tween. ([source](https://emilkowal.ski/ui/good-vs-great-animations))

### Когда НЕ анимировать

- **Лучшая анимация — её отсутствие** — цель не «красивые эффекты», а юзабельность. ([source](https://emilkowal.ski/ui/you-dont-need-animations))
- **Не анимируй частые действия** — то, что пользователь делает сотни раз в день (open/close меню типа Raycast), не должно тормозить анимациями. Восторг превращается в раздражение. ([source](https://emilkowal.ski/ui/you-dont-need-animations))
- **Никогда не анимируй клавиатурные шорткаты** — пользователь жмёт их быстро и часто; анимация ломает ощущение скорости. ([source](https://emilkowal.ski/ui/you-dont-need-animations))
- **Goal-oriented сценарии без анимаций** — когда юзер пришёл с конкретной задачей (рабочий инструмент), приоритет — эффективность, не «вау». ([source](https://emilkowal.ski/ui/you-dont-need-animations))
- **Минимизируй ховер-анимации на часто используемом** — если по элементу водят мышью десятки раз в день, ховер-эффект становится утомительным. ([source](https://emilkowal.ski/ui/you-dont-need-animations))

### Origin и направление

- **Анимация из точки триггера** — поповеры, дропдауны и тултипы должны раскрываться из своего trigger'а; настраивай `transform-origin`, чтобы движение было осмысленным. ([source](https://emilkowal.ski/ui/great-animations))
- **Не анимируй из `scale(0)`** — это выглядит неестественно; стартуй с `0.9`–`0.95`, движение будет мягче и элегантнее. ([source](https://emilkowal.ski/ui/7-practical-animation-tips))

### Кнопки и обратная связь

- **Скейль кнопки на :active** — `scale(0.97)` при нажатии даёт мгновенный тактильный фидбэк (особенно полезно для submit, copy и т.д.). ([source](https://emilkowal.ski/ui/7-practical-animation-tips))

### Тултипы и поповеры

- **Delay только на первом тултипе группы** — на первом ховере задержка нужна, чтобы не триггериться случайно; на соседних тултипах в той же группе — без задержки и без анимации. ([source](https://emilkowal.ski/ui/7-practical-animation-tips))

### Производительность

- **Анимируй только `transform` и `opacity`** — эти свойства hardware-accelerated; остальные дёргают layout/paint и роняют FPS. ([source](https://emilkowal.ski/ui/great-animations))
- **Цель — стабильные 60fps** — если frame drops, проще выкинуть анимацию, чем оставить дёрганную. ([source](https://emilkowal.ski/ui/great-animations))
- **CSS / WAAPI вместо JS-rAF** — нативные движки рисуют плавнее, чем `requestAnimationFrame` с ручным апдейтом стилей. ([source](https://emilkowal.ski/ui/great-animations))

### Прерываемость (interruptibility)

- **Анимации должны прерываться плавно** — пользователь может изменить состояние в любой момент; новая анимация должна стартовать из текущего положения, а не «доигрывать» предыдущую. Особенно важно для springs. ([source](https://emilkowal.ski/ui/great-animations))

### Доступность

- **Уважай `prefers-reduced-motion`** — для части пользователей анимации вызывают тошноту/отвлекают; отключай или упрощай по media-query. ([source](https://emilkowal.ski/ui/great-animations))

### Когда нужны анимации

- **Анимация = differentiation и забота** — «софт сегодня и так у всех нормальный»; продуманное движение — то, что выделяет продукт и формирует восприятие качества. ([source](https://emilkowal.ski/ui/good-vs-great-animations))
- **Animations as Proof of Care** — детали движения — сигнал, что над продуктом работали внимательно. ([source](https://animations.dev/changelog))

### Приёмы и трюки

- **Blur — спасательный круг** — если easing и duration не вытягивают, добавь лёгкий `filter: blur()` между состояниями; маскирует косяки и сглаживает переход. ([source](https://emilkowal.ski/ui/7-practical-animation-tips))
- **`clip-path` вместо одновременной анимации цвета и позиции** — даёт когерентный визуальный переход вместо «рассинхрона» свойств. ([source](https://emilkowal.ski/ui/good-vs-great-animations))
- **Записывай анимации покадрово** — замедленный просмотр выявляет огрехи, незаметные на нормальной скорости. ([source](https://animations.dev/changelog))
- **Тренируй вкус сравнением пар** — клади две версии анимации рядом и смотри, какая ощущается лучше. ([source](https://animations.dev/changelog))
