# Contract: `npm run release:channel -- <command>`

Кожна команда друкує короткий підсумок українською. З `--json` вона друкує один
JSON-об'єкт `{ ok, command, state, message, code? }`. Код виходу 0 означає успіх або
dry-run, 1 — відмову. Без `--confirm` команди, що змінюють прод, нічого не роблять і
показують, що зроблять.

| Команда | Що робить | Відмови |
|---|---|---|
| `status` | що на проді, що на next, куди буде відкат, чи є незавершена операція | — |
| `promote [--confirm]` | перевіряє живий next (index.html + stable.json) і архів, деплоїть ті самі байти на прод, перевіряє живий прод, запускає live smoke | `CHANNEL_NO_CANDIDATE`, `CHANNEL_NEXT_DRIFTED`, `CHANNEL_ARCHIVE_CHANGED`, `CHANNEL_DEPLOY_FAILED`, `CHANNEL_LIVE_MISMATCH`, `CHANNEL_LOCKED` |
| `rollback [--confirm]` | деплоїть `previous[0]` на прод і перевіряє живий прод | `CHANNEL_NO_PREVIOUS`, `CHANNEL_ARCHIVE_MISSING`, … |
| `cancel [--confirm]` | деплоїть поточний production-бандл на next, ставить `cancelled` | `CHANNEL_NO_CANDIDATE` |
| `adopt-live [--search=<dir>]… [--confirm]` | знаходить в архівах бандл, що збігається з живим продом, і реєструє його | `CHANNEL_LIVE_UNMATCHED` |

`deploy-web.mjs` після успішного завантаження на next сам записує publish у стан. Прямий
`deploy-web.mjs --channel=production` дозволений лише з токеном, який видає
`release-channel` під час promote, rollback чи cancel (змінна середовища
`SOTY_RELEASE_CHANNEL_TOKEN`, що збігається з lock).
