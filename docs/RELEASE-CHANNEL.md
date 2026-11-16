# Реліз через тестове посилання (051)

Коротко для власника: розбиратися в механіці не потрібно. Достатньо чотирьох слів.

| Ти кажеш        | Що відбувається                                                                 | Хто що бачить                                                                     |
| --------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| «готуй реліз»   | автоматичні перевірки, міграції бази, публікація на **https://next.soty.pp.ua** | ти й тестери бачать нову версію; усі інші — стару                                 |
| (знайшов косяк) | виправлення, нова збірка за **тим самим** посиланням                            | номер збірки внизу праворуч змінюється                                            |
| «розкатуй»      | на https://soty.pp.ua іде **рівно та** збірка, яку ти тестував                  | усі отримують нову версію                                                         |
| «відкоти»       | прод повертається на попередню версію разом з агентом                           | усі бачать попередню; кому вже встановився новий агент, сайт пропонує повернутися |
| «скасуй»        | next знову показує прод; кандидата немає                                        | нічого не змінюється для користувачів                                             |
| «що з релізом?» | стан: що на проді, що на тесті, куди буде відкат                                | —                                                                                 |

## Що варто знати

- **Тестова версія працює на справжніх даних.** Усе, що зробиш на next (завдання, каталоги), — справжнє.
- **Міграції бази накочуються до тесту.** Вони лише додають, тому стара версія на проді продовжує працювати і після відкату. CI не пропустить міграцію, що щось видаляє.
- **Хто бачить next:** адміністратори завжди, плюс список «Тестери релізів» в адмінці (Адмінка → огляд). Додаєш людину за email, яким вона входить у Soty.
- **Агент.** Якщо реліз змінює агента, на next є кнопка встановити тестовий агент. Він працює і з next, і з основним сайтом.
- **Перший реліз з цією фічею** приносить усе потрібне (довіру агента й функцій до next). До нього next працює лише з тестовим агентом.

## Команди (для агентів, що виконують реліз)

```bash
npm run release:channel -- status            # стан простими словами (--json для машин)
npm run release:channel -- promote           # що буде розкочено; нічого не змінює
npm run release:channel -- promote --confirm # розкатати перевірену збірку на прод
npm run release:channel -- rollback --confirm
npm run release:channel -- cancel --confirm
npm run release:channel -- adopt-live --confirm   # один раз: записати, що зараз на проді
```

- `deploy:web` (раннер повного релізу) і `release:web -- --deploy` публікують **на next**, а не на прод.
- Прод змінює лише `promote` / `rollback`, завжди з `--confirm` і лише за командою власника.
- Стан і архів бандлів лежать у спільному `release/automation/release-channel/` основної копії репозиторію (видно з усіх воркдерев раннера). Історія операцій: `history.jsonl` поруч.

## Швидкі ревізії на next (рішення власника 2026-11-16)

next — для того, щоб власник за хвилини пробував фікси на реальних даних у своєму просторі.
Повний раннер (Windows CI, Intel, нотаризовані інсталятори, packaged-beta) — це ворота перед продом,
а не цикл для кожного фіксу.

```bash
npm run next:quick              # що змінилось від останньої публікації на next і що буде
npm run next:quick -- --confirm # lint/typecheck/пов'язані тести → бекенд-план → Worker → сайт на next
```

- Лише закомічений код. Зміни, які мав би нести встановлений застосунок (`apps/agent`, `packaging`,
  `packages/shared` крім версії), відмовляються — для них повний раннер.
- Серверна частина спільна з продом: вона йде тим самим `plan-backend-release` + `apply-backend-plan`,
  що й у раннері, з тими самими перевірками сумісності з випущеним застосунком.
- Швидка публікація **не** записується в канал, тому `promote` відповідає `CHANNEL_NEXT_DRIFTED`,
  доки повний реліз знову не опублікує next. На прод нічого не потрапляє без повних воріт.
- Журнал: `release/automation/next-quick.jsonl`.

Зміна самого застосунку — `npm run next:quick:app [-- --confirm]` (~20–30 хв): лише macOS arm64,
ідентичність `<наступний патч>-next.<N>` (напр. `1.5.6-next.91`) на гілці `next-quick/<версія>`,
підпис Developer ID + нотаризація, GitHub **prerelease**, підписаний `stable.json` з автооновленням
arm64, сайт на next. Решта платформ у маніфесті лишаються інсталяторами останнього повного релізу.
Наступний повний реліз бере `BUILD_NUMBER` більший за всі швидкі збірки (див. журнал), інакше
Mac на каналі next не побачить його новішим.

## Native macOS update archives

Native archive metadata travels inside the same signed `stable.json` archived with the site. `next` can display the candidate installer, while the installed native host checks the promoted production origin by default. A tester's Mac opts into next's manifest at runtime — the build never carries a channel, because promote ships those very bytes to production: `defaults write local.video.compressor.test SotyUpdateChannel next`, then quit and reopen Soty (`defaults delete local.video.compressor.test SotyUpdateChannel` returns it to production). Only the two baked addresses are reachable, both verified with the same release manifest key.

**Owner decision 2026-11-16:** next may carry a build whose updater was enabled with its qualification deferred (`SOTY_NATIVE_UPDATES=qualification-deferred-until-promote`). `promote` refuses any candidate whose signed manifest advertises native updates unless `--native-update-qualification=<record>` names a valid `native-update-qualification` record for the descriptors' exact `sourceRevision` (`CHANNEL_NATIVE_UPDATE_QUALIFICATION_REQUIRED`); the dry run says so before `--confirm`, and the record's digest is kept in the promote history. Promote and rollback move those exact archived signed bytes; snapshot validation rejects native target/build mismatches. ZIP assets are immutable and published/read back by the full release runner.

Rollback does not authorize automatic native downgrade after the new target has started. An uncertain replacement blocks replay and presents recovery; manual recovery uses the signed installer. See [052 implementation and qualification](../specs/052-macos-native-updates/implementation.md). No native acceptance or production authorization is implied by source implementation.
