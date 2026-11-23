# Contract: інтерфейс

Еталон — «лакшері мінімалізм» з `docs/DESIGN.md`: менше тексту, слова в тултіпах, іконки lucide 20 px, контроли лише з інвентарю, значення лише з токенів. Орієнтири:
- ряд мов — як вкладки мов у Frame.io (транскрипти/субтитри);
- вибір мови — як «Translate to…» у Google Docs: пошук, недавні вгорі;
- вартість — як кредитний рядок у Linear AI: одне речення, без діалогу підтвердження.

## Спільні частини (`apps/web/src/translation/`)

### `TextVariantTabs`

`Tabs` з інвентарю: одна позначка, що їде до обраного. Вкладки:
- `Оригінал · TR` — код мови оригіналу малими капітелями. Без коду, якщо мова невідома.
- По вкладці на переклад, назва мови через `languageDisplayName`, порядок — за часом створення.
  - `processing` — замість іконки маленьке кільце `Progress circular` з відсотком у `aria-valuetext`.
  - Стара (stale) — крапка `warning` з тултіпом «За старим текстом».
  - `failed` без готового попереднього — вкладка не показується, стан живе у плашці.
- Останнім — `IconButton` `Plus` (`aria-label` «Перекласти на іншу мову»). Він відкриває `TranslateLauncher` у `Popover`, прив'язаному до кнопки.
- Переповнення ряду: `ScrollShadow` по горизонталі всередині шапки. Сторінка не прокручується.

### `TranslateLauncher` (Popover, ширина `--translation-launcher-width`)

1. `LanguageCombobox` (наявний, `pinned` = мови з попередніх перекладів користувача; список — `TRANSLATION_TARGET_LANGUAGES` без мови оригіналу).
2. Рядок вартості, `text-small`:
   - **вистачає**: `≈ 3 хв · лишилось 7 з 10 хв` (muted) + `Button color="primary"` «Перекласти»; Enter у полі мови запускає.
   - **не вистачає**: `Alert color="warning" variant="soft"`: «Потрібно ≈ 3 хв, лишилось 2 хв. Ліміт оновиться о 00:00.» Кнопки «Перекласти» немає.
   - **довше за день**: `Alert color="warning"`: «Текст ≈ 14 хв — це більше за денний ліміт 10 хв.» Кнопки немає.
   - **переклад цією мовою вже є**: замість вартості — «Уже перекладено», кнопка «Відкрити» (secondary). Списання немає.
   - **недоступно** (немає ключа / збій статусу): `Alert color="neutral"`: «Переклад зараз недоступний».
3. Тултіп на «хв»: «Хвилина перекладу — це близько 900 знаків тексту, а не тривалість відео».
4. Під час запиту `start` кнопка показує `Spinner`. Після відповіді поповер закривається, а на місці з'являється плашка й нова вкладка.

### `TranslationProgress` (плашка)

`Card` з `variant="soft"`, висота ряду 44: іконка `Languages`, «Перекладаю: українська», відсоток праворуч, під ними `Progress size="sm" color="secondary"`. Заповнення:
- `scaleX(var(--fill-ratio))` з переходом `--motion-slow` `--ease-out-curve`;
- значення — `max(показане, реальне)`, а між подіями плавно повзе до наступного кроку (не далі за 92%), оцінка — 4 с на шматок;
- `done` → 100% за `--motion-base`, потім плашка згасає (`opacity`), а вкладка перекладу стає активною;
- `failed` → плашка лишається з текстом причини й `Button size="sm" variant="ghost"` «Спробувати ще раз», колір `neutral`. Відмова — не червона: це не поломка;
- `aria-live="polite"` оголошує лише початок, кожні 25% і кінець.

### `TextVariantReader`

Список сегментів `<p>` з `dir` за мовою (`isRtlLanguage`). Ширина рядка ≤ 70ch, шрифт інтерфейсу `--text-body`, міжрядковий інтервал — `--leading-relaxed`, якщо токен є. Порожні сегменти не рендеряться. Виділення тексту — звичайне.

### `CopyVariantButton`

- Один варіант → копіює одразу. Кнопка міняє слово на «Скопійовано» (1,5 с) без руху.
- Кілька → `DropdownMenu`: «Оригінал · TR», «Українська», … Вибір копіює одразу, а тост каже «Скопійовано: Українська».
- `stale`/`processing` варіанти в меню: `processing` вимкнений із підписом прогресу; `stale` — з позначкою.

## Простір

### Бічна картка відео (`PreviewPane` → `VideoTextActions compact`)

Ряд кнопок: `Переглянути` · `Копіювати` (`CopyVariantButton`) · `IconButton Languages` («Перекласти») · `Ще раз`. Коли є переклади, під кнопками стоїть рядок чипів мов (`Chip size="sm"`, до 3 + «+N»). Клік відкриває вікно перегляду на цьому варіанті. Під час перекладу під рядом стоїть `TranslationProgress` (compact, без картки).

### Вікно перегляду тексту простору (заміна `<pre>`)

`Modal size="xl"`:
- шапка: назва відео (одним рядком з обрізанням і повною назвою в тултіпі) + `TextVariantTabs`;
- тіло: `TextVariantReader` з власною прокруткою;
- для stale-варіанта над текстом стоїть `Alert soft warning`: «Переклад зроблено за старим текстом» + `Button` «Оновити переклад · ≈ 3 хв»;
- низ: `CopyVariantButton` для поточного варіанта (копіює лише його) і `Button primary` «Готово».

## Транскрибатор

- `TranscriptTextModal`: у порожньому слоті шапки — `TextVariantTabs`. Коли вибрано переклад, колонка показує `TextVariantReader` перекладу з підсвіткою поточного сегмента за часом плеєра (сегментна, не караоке); заголовок колонки — назва мови. Копіювання колонки копіює вибраний варіант. Під час перекладу плашка стоїть над колонкою.
- `ExportMenu`: якщо вибрано переклад — пункти експорту працюють для нього (TXT, SRT/VTT з таймінгами оригіналу). Заголовок меню показує мову.
- `TranscriptionCopyMenu` у рядку: пункти «Оригінал» + кожен готовий переклад. Переклади читаються лінивo при відкритті меню.

## Тексти (uk / en)

| Ключ | uk | en |
| --- | --- | --- |
| `textTranslationAction` | Перекласти | Translate |
| `textTranslationAnother` | Перекласти на іншу мову | Translate into another language |
| `textTranslationOriginal` | Оригінал | Original |
| `textTranslationCost` | ≈ {need} хв · лишилось {left} з {limit} хв | ≈ {need} min · {left} of {limit} min left |
| `textTranslationShort` | Потрібно ≈ {need} хв, лишилось {left} хв. Ліміт оновиться о {time}. | Needs ≈ {need} min, {left} min left. The limit renews at {time}. |
| `textTranslationTooLong` | Текст ≈ {need} хв — це більше за денний ліміт {limit} хв. | This text is ≈ {need} min, more than the daily limit of {limit} min. |
| `textTranslationMinuteHint` | Хвилина перекладу — це близько 900 знаків тексту, а не тривалість відео. | A translation minute is about 900 characters of text, not video length. |
| `textTranslationInProgress` | Перекладаю: {language} | Translating: {language} |
| `textTranslationRefused` | Модель відмовилась перекладати цей текст. Хвилини повернуто. | The model declined to translate this text. Minutes returned. |
| `textTranslationUnavailable` | Переклад зараз недоступний. Хвилини не списано. | Translation is unavailable right now. No minutes used. |
| `textTranslationFailed` | Не вдалося перекласти. Хвилини повернуто. | Translation failed. Minutes returned. |
| `textTranslationRetry` | Спробувати ще раз | Try again |
| `textTranslationStale` | Переклад зроблено за старим текстом | Translated from an earlier version of the text |
| `textTranslationRefresh` | Оновити переклад · ≈ {need} хв | Update translation · ≈ {need} min |
| `textTranslationExists` | Уже перекладено | Already translated |
| `textTranslationOpen` | Відкрити | Open |
| `textTranslationCopied` | Скопійовано: {variant} | Copied: {variant} |
| `textTranslationLanguageLabel` | Мова перекладу | Translation language |

Назву мови дає `Intl.DisplayNames` у називному відмінку («українська»), тому плашка пише «Перекладаю: українська», а не «на українську»: відмінювати назви мов автоматично не можна.
