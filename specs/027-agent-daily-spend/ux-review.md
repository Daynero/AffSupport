# UX review — 2026-10-03

Оцінка за браузерними сценаріями й візуальним оглядом, не заміна дослідження з користувачами. Реалізація ще не завершена.

## Що покращено й перевірено

- Операційні агенти та щоденні фінанси розділені на два види без втрати чернетки при перемиканні.
- Календар відкривається за потреби; є стрілки дня/місяця, швидкі періоди й помітний активний вибір. Майбутні фінансові дні заблоковані.
- Повний ID агента й дата доступні в назвах полів; максимальна сума вміщується. Невалідний Tab утримує фокус, Escape повертає збережене значення.
- Пошук не дозволяє приховати незбережену чернетку. Загальні суми явно підписані «Весь простір», тому фільтр не створює хибне очікування зміни підсумку.
- Історія доступна поруч із агентом, рідкісні/небезпечні дії винесені в меню. Масове очищення підтверджує дату й кількість полів та підтримує надійний retry/Undo.
- Місячна матриця має обмежену висоту й закріплену дату; на мобільному прокручується таблиця, а не вся сторінка.
- Імпорт старих грошей вимагає явної дати, суми, USD та окремого підтвердження.

## Залишок перед завершенням

1. Матрицю, підсумки та виписку вже розділено на вкладки. Потрібне вимірювання p95 на 500 агентах і перевірка довгого списку на вкладці підсумків.
2. Додано повернення з дня зі збереженням вкладки, метрики, прокрутки та фокусу дати матриці. Залишається перевірка відновлення фокусу рядка виписки.
3. Тристоронній guard «Зберегти / Відкинути / Залишитись» реалізовано й перевірено в браузері. Залишаються browser-back та offline/logout/permission lifecycle.
4. Пошук цільового соц і пояснення недоступної дати перенесення додано. Залишаються посилання з імпорту на історичну подію.
5. Поліпшити пояснення обмежень Excel та перевірити контрольний файл у Microsoft Excel. Native Deno QA не замінює packaged Docker/release gates.

Артефакти: `validation/finance-real-{light,dark}-390.png`, `validation/finance-real-month-{light,dark}-390.png`. Браузерний стенд використовує локальний beta auth, справжні RPC та власний тимчасовий простір, не production.

## User beta review — 2026-10-04

Replaced the separate day calendar with the task range control. Custom ranges
retain both bounds through dirty navigation, day drill-down and return; arrows
shift them by their inclusive duration. One request is bounded to 366 days with
an explicit message. Full-month shortcuts remain available.

The matrix fills remaining viewport height, uses matching fixed minimum column
tracks, opaque sticky date/header layers and a sticky Spend/Topup footer. Balance
still has no misleading cross-day total. Browser assertions verify the footer
is visible and date cells cannot cover the header while scrolling.

Daily finance uses compact agent rows and social headings, preserving the actual
editable agent labels. Identity suffixes use the existing orange data token in
both views; identity columns are wider and wrapped content is vertically centered.

Actual Safari range selection and Excel downloads passed. Source beta currently
uses an explicitly opted-in native runner for the unchanged Edge function because
Docker is unhealthy; it retains real JWT checks. Full packaged beta remains
unverified, and no production release was performed.
