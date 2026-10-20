/** Local, offline visual report. No network requests, external assets or user content. */
export function renderCatalogScheduleReport(data: unknown): string {
  const payload = JSON.stringify(data)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'"><title>Розклади каталогів — Soty</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111017;color:#eeeaf7}*{box-sizing:border-box}body{margin:0;padding:32px;max-width:1540px;margin-inline:auto}h1{font-size:28px;margin:0 0 8px}h2{font-size:19px;margin:0 0 8px}h3{font-size:16px;margin:0 0 8px}p{margin:6px 0;line-height:1.5}.muted,small{color:#b4adbf}.intro{margin-bottom:24px}.summary,.grid{display:grid;gap:18px}.summary{grid-template-columns:repeat(4,minmax(0,1fr));margin:22px 0}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.card{background:#1b1823;border:1px solid #373040;border-radius:14px;padding:20px;min-width:0}.metric{font-size:30px;font-weight:650;color:#baa0ff}.wide{grid-column:1/-1}.chart{overflow:auto;min-height:80px;margin-top:14px}.chart svg{display:block;width:100%;min-width:540px}svg text{font-family:system-ui,sans-serif;fill:#ccc4d7;font-size:14px}svg .value{fill:#f3eff9;font-weight:600}.empty{color:#b4adbf;padding:24px 0}.notice{border-left:3px solid #b79aff;padding:8px 14px;background:#211b2d;margin:16px 0}select{font:inherit;background:#282232;color:#eeeaf7;border:1px solid #514562;border-radius:8px;padding:8px 12px;max-width:100%}.user{margin-top:16px}.user-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:9px;border-bottom:1px solid #373040}th{color:#b4adbf;font-weight:500}.table-wrap{overflow:auto}details{margin-top:14px}summary{cursor:pointer;color:#cbb7ff}.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin:12px 0}.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px}.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:20px 0}.foot{margin-top:24px;font-size:13px}@media(max-width:900px){body{padding:18px}.grid{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,1fr)}}
</style></head><body><header class="intro"><p class="muted">SOTY · АНАЛІТИКА КАТАЛОГІВ</p><h1>Як налаштовують автооновлення</h1><p id="period" class="muted"></p></header><div id="coverage" class="notice"></div><div id="summary" class="summary"></div><main class="grid" id="charts"></main><section class="card user"><h2>Історії користувачів</h2><p class="muted">Кожна точка — підтверджена зміна цим користувачем. Окремі доріжки — окремі каталоги. Інші редактори могли змінювати той самий каталог між точками.</p><div class="controls"><label for="user">Показати користувача</label><select id="user"><option value="">Усі користувачі вибірки</option></select></div><div id="users"></div></section><footer class="foot muted" id="foot"></footer><script id="report-data" type="application/json">${payload}</script><script>const __name = (value) => value; (${reportClient.toString()})();</script></body></html>`;
}

function reportClient() {
  type Row = Record<string, unknown>;
  const raw: unknown = JSON.parse(document.getElementById('report-data')!.textContent!);
  const record = (value: unknown): Row =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
  const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
  const str = (value: unknown) => (value == null ? '' : String(value));
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
  const data = record(raw),
    period = record(data.period),
    coverage = record(data.coverage),
    current = record(data.current),
    truncation = record(data.truncation);
  const el = (tag: string, text?: string, className?: string) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (className) e.className = className;
    return e;
  };
  const append = (parent: Element, tag: string, text?: string, className?: string) => {
    const e = el(tag, text, className);
    parent.append(e);
    return e;
  };
  const label = (value: unknown): string => {
    const v = str(value);
    return !v || v === 'off'
      ? 'Вимкнено'
      : v === '1h'
        ? 'Щогодини'
        : v === '1d'
          ? 'Щодня'
          : v === '1w'
            ? 'Щотижня'
            : v.endsWith('h')
              ? `Кожні ${v.slice(0, -1)} год`
              : v;
  };
  const colors = ['#ac8aff', '#63cbb5', '#77a8f5', '#f2b86a', '#e991b0', '#b5cb73', '#a9a0b6'];
  const intervals = Array.from(
    new Set(
      [
        ...rows(current.distribution),
        ...rows(data.popularity),
        ...rows(data.interval_daily_endstate)
      ].map(r => str(r.interval))
    )
  );
  const color = (interval: unknown) =>
    colors[Math.max(0, intervals.indexOf(str(interval))) % colors.length];
  const date = (value: unknown) => {
    const d = new Date(str(value));
    return Number.isFinite(d.getTime())
      ? d.toLocaleString('uk-UA', {
          timeZone: 'UTC',
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        })
      : 'невідомо';
  };
  document.getElementById('period')!.textContent =
    `${period.start ? date(period.start) : 'Від початку спостереження'} — ${date(period.end)} · межі днів UTC · ${record(data.scope).mode === 'actor' ? 'дії вибраного користувача' : 'усі користувачі'}`;
  const notes = Array.isArray(coverage.notes) ? coverage.notes.map(str) : [];
  const notice = document.getElementById('coverage')!;
  if (data.demo === true) {
    document.title = 'ДЕМОНСТРАЦІЯ — тестові дані';
    document.querySelector('h1')!.textContent = 'ДЕМОНСТРАЦІЯ · тестові дані';
    append(notice, 'p', 'Це штучна перевірочна вибірка, а не статистика реальних користувачів.');
  }
  append(
    notice,
    'strong',
    `Історія спостерігається з ${coverage.observed_since ? date(coverage.observed_since) : 'ще не зібрано'}.`
  );
  append(
    notice,
    'p',
    'Старі налаштування — початковий знімок, а не доказ того, коли або ким їх обрали. Історія до початку збору невідома.'
  );
  if (notes.length) {
    const details = append(notice, 'details');
    append(details, 'summary', 'Деталі покриття й обмеження');
    for (const note of notes) append(details, 'p', note, 'muted');
  }
  if (
    num(truncation.users_total) > num(truncation.users_returned) ||
    num(truncation.timeline_total) > num(truncation.timeline_returned)
  )
    append(
      notice,
      'p',
      'Детальні історії показані обмеженою вибіркою; підсумкові графіки охоплюють усі доступні записи.'
    );
  const unavailable = data.status === 'unsupported_by_producer';
  if (coverage.capture_enabled === false)
    append(
      notice,
      'p',
      'УВАГА: збір змін вимкнений. Показані останні відомі стани; вони можуть бути застарілими.'
    );
  else if (coverage.capture_enabled == null && !unavailable)
    append(notice, 'p', 'Стан серверного збору не підтверджений. Повнота нових записів невідома.');
  if (num(truncation.daily_days_total) > num(truncation.daily_days_returned))
    append(
      notice,
      'p',
      `Часові графіки обмежені останніми ${num(truncation.daily_days_returned)} днями з ${num(truncation.daily_days_total)}; підсумкові кількості охоплюють увесь період.`
    );
  if (num(current.unknown_last_editors))
    append(
      notice,
      'p',
      `Останній автор налаштувань невідомий для ${num(current.unknown_last_editors)} поточних каталогів.`
    );
  const summary = document.getElementById('summary')!;
  for (const [title, value] of [
    ['Активних каталогів', current.catalogs],
    ['Підтверджених змін', num(record(data.totals).confirmed_changes)],
    ['Відомих редакторів зараз', current.known_last_editors],
    ['Змін без відомого автора', coverage.unknown_actor_changes]
  ]) {
    const c = append(summary, 'div', undefined, 'card');
    append(c, 'div', unavailable ? 'невідомо' : str(value ?? 0), 'metric');
    append(c, 'small', str(title));
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svgNode = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const plot = (parent: Element, width: number, height: number, title: string) => {
    const s = svgNode('svg', {
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': title
    });
    parent.append(s);
    return s;
  };
  const card = (title: string, description: string, wide = false) => {
    const c = append(
      document.getElementById('charts')!,
      'section',
      undefined,
      wide ? 'card wide' : 'card'
    );
    append(c, 'h2', title);
    append(c, 'p', description, 'muted');
    return append(c, 'div', undefined, 'chart');
  };
  const empty = (p: Element) =>
    append(
      p,
      'p',
      unavailable
        ? 'Дані недоступні: джерело історії ще не підключене або немає доступу.'
        : 'Поки немає підтверджених даних для цього графіка.',
      'empty'
    );
  const table = (parent: Element, headings: string[], items: string[][]) => {
    const wrap = append(parent, 'div', undefined, 'table-wrap'),
      t = append(wrap, 'table'),
      head = append(t, 'thead'),
      tr = append(head, 'tr');
    for (const h of headings) append(tr, 'th', h);
    const body = append(t, 'tbody');
    for (const item of items) {
      const r = append(body, 'tr');
      for (const v of item) append(r, 'td', v);
    }
  };
  const bars = (
    p: Element,
    values: Array<{ label: string; value: number; color?: string }>,
    unit: string
  ) => {
    if (!values.length) {
      empty(p);
      return;
    }
    const width = 620,
      left = 190,
      right = 55,
      row = 34,
      max = Math.max(1, ...values.map(v => v.value)),
      s = plot(p, width, values.length * row + 16, unit);
    values.forEach((v, i) => {
      const y = i * row + 5;
      s.append(svgNode('text', { x: 0, y: y + 17 }, v.label));
      const bar = svgNode('rect', {
        x: left,
        y,
        width: ((width - left - right) * v.value) / max,
        height: 24,
        rx: 4,
        fill: v.color ?? colors[i % colors.length]
      });
      bar.append(svgNode('title', {}, `${v.label}: ${v.value} ${unit}`));
      s.append(
        bar,
        svgNode(
          'text',
          { x: left + ((width - left - right) * v.value) / max + 8, y: y + 17, class: 'value' },
          String(v.value)
        )
      );
    });
  };
  const dist = rows(current.distribution);
  bars(
    card(
      'Які інтервали встановлено зараз',
      record(data.scope).mode === 'actor'
        ? 'Активні каталоги, останнім відомим редактором налаштувань яких є цей користувач. Це не перелік його власності.'
        : 'Кількість активних каталогів на кінець періоду. Один каталог = одне налаштування.'
    ),
    dist.map(r => ({ label: label(r.interval), value: num(r.catalogs), color: color(r.interval) })),
    'каталогів'
  );
  const popular = rows(data.popularity);
  bars(
    card(
      'Що обирали користувачі за період',
      'Унікальні відомі автори, які підтверджено обрали інтервал. Користувач може бути в кількох категоріях.'
    ),
    popular.map(r => ({
      label: label(r.interval),
      value: num(r.distinct_actors),
      color: color(r.interval)
    })),
    'користувачів'
  );
  bars(
    card(
      'Скільки разів змінювали інтервали',
      'Підтверджені зміни інтервалу, включно з вимкненням; початкові знімки та невдалі спроби не рахуються.'
    ),
    popular.map(r => ({
      label: label(r.interval),
      value: num(r.selections),
      color: color(r.interval)
    })),
    'виборів'
  );
  const daily = rows(data.daily);
  const activity = card(
    'Активність за днями',
    'Фіолетовий — усі підтверджені зміни; зелений — зміни інтервалу. Календарні дні UTC.'
  );
  if (!daily.length) empty(activity);
  else {
    const width = 760,
      height = 220,
      left = 40,
      right = 18,
      top = 20,
      bottom = 35,
      max = Math.max(1, ...daily.map(r => num(r.confirmed_changes))),
      chart = plot(activity, width, height, 'Підтверджені зміни за днями');
    const x = (i: number) => left + (i * (width - left - right)) / Math.max(1, daily.length - 1),
      y = (n: number) => height - bottom - (n * (height - top - bottom)) / max;
    chart.append(
      svgNode('line', {
        x1: left,
        x2: width - right,
        y1: height - bottom,
        y2: height - bottom,
        stroke: '#51475f'
      })
    );
    for (const [field, fill] of [
      ['confirmed_changes', colors[0]],
      ['interval_changes', colors[1]]
    ]) {
      chart.append(
        svgNode('path', {
          d: daily.map((r, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(num(r[field]))}`).join(' '),
          fill: 'none',
          stroke: fill,
          'stroke-width': 2
        })
      );
      daily.forEach((r, i) => {
        const dot = svgNode('circle', { cx: x(i), cy: y(num(r[field])), r: 3, fill });
        dot.append(
          svgNode(
            'title',
            {},
            `${str(r.date)} · ${field === 'confirmed_changes' ? 'усі зміни' : 'інтервали'}: ${num(r[field])}`
          )
        );
        chart.append(dot);
      });
    }
    daily.forEach((r, i) => {
      if (i % Math.max(1, Math.ceil(daily.length / 10)) === 0)
        chart.append(
          svgNode(
            'text',
            { x: x(i), y: height - 10, 'text-anchor': i ? 'middle' : 'start' },
            str(r.date).slice(5)
          )
        );
    });
    chart.append(
      svgNode('text', { x: 0, y: top + 4 }, String(max)),
      svgNode('text', { x: 0, y: height - bottom }, '0')
    );
  }
  const stateRows = rows(data.interval_daily_endstate),
    days = Array.from(new Set(stateRows.map(r => str(r.date))));
  const history = card(
    'Як змінювався розподіл інтервалів',
    'Активні каталоги на кінець кожного дня UTC. Дні до першого спостереження не відновлюються заднім числом.',
    true
  );
  if (!stateRows.length) empty(history);
  else {
    const width = Math.max(760, days.length * 38),
      height = 260,
      left = 45,
      bottom = 35,
      top = 12,
      max = Math.max(
        1,
        ...days.map(d =>
          stateRows.filter(r => str(r.date) === d).reduce((a, r) => a + num(r.catalogs), 0)
        )
      ),
      s = plot(history, width, height, 'Розподіл активних каталогів за днями');
    const legend = append(history, 'div', undefined, 'legend');
    for (const v of intervals) {
      const item = append(legend, 'span');
      const dot = append(item, 'i', undefined, 'dot');
      dot.style.background = color(v);
      item.append(document.createTextNode(label(v)));
    }
    days.forEach((d, i) => {
      let y = height - bottom;
      for (const v of intervals) {
        const count = stateRows
            .filter(r => str(r.date) === d && str(r.interval) === v)
            .reduce((a, r) => a + num(r.catalogs), 0),
          h = ((height - top - bottom) * count) / max;
        y -= h;
        const rect = svgNode('rect', {
          x: left + (i * (width - left)) / days.length,
          y,
          width: Math.max(3, (width - left) / days.length - 6),
          height: h,
          fill: color(v)
        });
        rect.append(svgNode('title', {}, `${d}: ${label(v)} · ${count} каталогів`));
        s.append(rect);
      }
      if (i % Math.max(1, Math.ceil(days.length / 14)) === 0)
        s.append(
          svgNode(
            'text',
            { x: left + (i * (width - left)) / days.length, y: height - 10 },
            d.slice(5)
          )
        );
    });
    s.append(
      svgNode('text', { x: 0, y: 18 }, String(max)),
      svgNode('text', { x: 0, y: height - bottom }, '0')
    );
  }
  const transitions = rows(data.transitions).sort((a, b) => num(b.changes) - num(a.changes));
  bars(
    card(
      'Переходи між інтервалами',
      '20 найчастіших переходів. Напрямок показує попередній і новий збережений інтервал. Параметри часу без зміни інтервалу тут не додають переходу.'
    ),
    transitions.slice(0, 20).map(r => ({
      label: `${label(r.from)} → ${label(r.to)}`,
      value: num(r.changes),
      color: color(r.to)
    })),
    'переходів'
  );
  const custom = rows(data.custom_hours);
  bars(
    card(
      'Власні інтервали в годинах',
      '20 найпоширеніших власних інтервалів за кількістю активних каталогів. Еквіваленти 1/24/168 год нормалізуються в основних графіках.'
    ),
    [...custom]
      .sort((a, b) => num(b.catalogs) - num(a.catalogs))
      .slice(0, 20)
      .map(r => ({ label: `${num(r.hours)} год`, value: num(r.catalogs) })),
    'каталогів'
  );
  const options = rows(data.options),
    optionNames: Record<string, string> = {
      restitch: 'Перезашивка відео',
      refreshImages: 'Зображення',
      refreshTexts: 'Тексти й ціни',
      growProducts: 'Нові товари',
      randomLinkVariation: 'Варіація посилання'
    };
  const optionCard = card(
    'Що ввімкнено в каталогах',
    'Поточне прийняття параметрів незалежно від розкладу; нижче — скільки разів їх підтверджено вмикали та вимикали за період.'
  );
  bars(
    optionCard,
    options.map(r => ({
      label: optionNames[str(r.field)] ?? str(r.field),
      value: num(r.enabled_catalogs)
    })),
    'каталогів'
  );
  if (options.length)
    table(
      optionCard,
      ['Параметр', 'Увімкнули', 'Вимкнули', 'Відомих авторів'],
      options.map(r => [
        optionNames[str(r.field)] ?? str(r.field),
        str(r.enabled_changes),
        str(r.disabled_changes),
        str(r.distinct_actors)
      ])
    );
  const clock = rows(data.schedule_clock);
  const clockCard = card(
    'Обраний час і день',
    'Поточні та зафіксовані за період календарні розклади. Час показаний у збереженому часовому поясі, а не перерахований на UTC.'
  );
  if (!clock.length) empty(clockCard);
  else
    table(
      clockCard,
      ['Час', 'День ISO¹', 'Часовий пояс', 'Каталоги', 'Вибори'],
      clock.map(r => [
        str(r.time),
        r.weekday == null ? 'щодня' : str(r.weekday),
        str(r.time_zone),
        str(r.catalogs),
        str(r.confirmed_selections)
      ])
    );
  const users = rows(data.users),
    select = document.getElementById('user') as HTMLSelectElement;
  for (const u of users) {
    const o = document.createElement('option');
    o.value = str(u.user_id);
    o.textContent = str(u.user_id);
    select.append(o);
  }
  const renderUsers = () => {
    const host = document.getElementById('users')!;
    host.replaceChildren();
    const visible = users.filter(u => !select.value || str(u.user_id) === select.value);
    if (!visible.length) {
      empty(host);
      return;
    }
    for (const u of visible) {
      const c = append(host, 'article', undefined, 'card user');
      append(c, 'h3', `Користувач ${str(u.user_id)}`);
      append(
        c,
        'p',
        `${num(u.confirmed_changes)} змін · ${num(u.catalogs_changed)} каталогів`,
        'muted'
      );
      const before = record(u.first_observed_before);
      if (before.at)
        append(
          c,
          'p',
          `Перед першою зафіксованою зміною: ${label(before.interval)}. Це попередній стан, а не доказ початкового наміру користувача.`,
          'muted'
        );
      const first = record(u.first_observed),
        last = record(u.latest_observed);
      append(
        c,
        'p',
        `Стан після першої зафіксованої зміни: ${label(first.interval)} (${date(first.at)}). Останній зафіксований стан: ${label(last.interval)} (${date(last.at)}).`,
        'muted'
      );
      const events = rows(u.timeline),
        catalogs = Array.from(new Set(events.map(e => str(e.catalog_id))));
      if (!events.length) {
        empty(c);
        continue;
      }
      const p = append(c, 'div', undefined, 'chart'),
        width = 1000,
        left = 130,
        right = 30,
        row = 44,
        height = catalogs.length * row + 40;
      const min = period.start
          ? Date.parse(str(period.start))
          : Math.min(...events.map(e => Date.parse(str(e.at)))),
        max = Date.parse(str(period.end)),
        span = Math.max(1, max - min),
        x = (v: unknown) =>
          left +
          Math.max(0, Math.min(1, (Date.parse(str(v)) - min) / span)) * (width - left - right),
        s = plot(p, width, height, 'Підтверджені зміни користувача по каталогах');
      catalogs.forEach((id, i) => {
        const y = i * row + 22;
        s.append(
          svgNode('text', { x: 0, y: y + 4 }, `…${id.slice(-10)}`),
          svgNode('line', { x1: left, x2: width - right, y1: y, y2: y, stroke: '#51475f' })
        );
        for (const e of events.filter(e => str(e.catalog_id) === id)) {
          const circle = svgNode('circle', { cx: x(e.at), cy: y, r: 7, fill: color(e.to) });
          circle.append(
            svgNode(
              'title',
              {},
              `${date(e.at)} · ${label(e.from)} → ${label(e.to)} · параметри: ${Array.isArray(e.options_changed) ? e.options_changed.map(str).join(', ') : ''}`
            )
          );
          s.append(circle);
        }
      });
      s.append(
        svgNode('text', { x: left, y: height - 4 }, date(new Date(min).toISOString())),
        svgNode('text', { x: width - right, y: height - 4, 'text-anchor': 'end' }, date(period.end))
      );
      const details = append(c, 'details');
      append(details, 'summary', 'Точна послідовність змін');
      table(
        details,
        ['Коли (UTC)', 'Каталог', 'Було', 'Стало', 'Параметри'],
        events.map(e => [
          date(e.at),
          str(e.catalog_id),
          label(e.from),
          label(e.to),
          Array.isArray(e.options_changed) ? e.options_changed.map(str).join(', ') : ''
        ])
      );
    }
  };
  select.addEventListener('change', renderUsers);
  renderUsers();
  const foot = document.getElementById('foot')!;
  append(
    foot,
    'p',
    `Доріжок користувачів: ${num(truncation.users_returned)} / ${num(truncation.users_total)}. Подій у доріжках: ${num(truncation.timeline_returned)} / ${num(truncation.timeline_total)}. Обмеження деталізації не обрізають загальні агрегати.`
  );
  append(
    foot,
    'p',
    `Днів у часовому ряді: ${num(truncation.daily_days_returned)} / ${num(truncation.daily_days_total)}. Для довгих періодів показуються останні доступні дні; підсумкові кількості та переходи рахуються за весь запитаний період.`
  );
  append(
    foot,
    'p',
    '¹ ISO день: 1 — понеділок, 7 — неділя. Ідентифікатори псевдонімізовані; імена каталогів та їхній вміст не збираються. Серверна історія доводить збереження, але не доводить, що користувач побачив результат. Звіт працює локально без мережевих запитів.'
  );
}
