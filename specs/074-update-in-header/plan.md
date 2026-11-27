# План 074 · Оновлення на видноті

[Вимоги](spec.md) · [Задачі](tasks.md)

## Архітектура

Одне джерело правди про пропозицію оновлення замість трьох незалежних читачів (`LegacyReleaseUpdateNotice`, `NativeAppUpdateNotice`, меню користувача).

```
AgentProvider
 └─ UpdateCenterProvider            (новий, apps/web/src/updates/UpdateCenter.tsx)
     ├─ useNativeAppUpdate(…)        — один екземпляр на сторінку (раніше — у плашці)
     ├─ legacy-статус з маніфесту    — installedReleaseStatus(...)
     └─ offer: UpdateOffer           — { channel: 'native'|'installer', version, buildId,
                                          phase: 'available'|'downloading'|'waiting'|'installing'
                                                 |'ready'|'attention', fraction?, required }
        start()                      — native: prepare → (prepared) accept; installer: скачати
        openDetails()                — наявна подія OPEN_NATIVE_APP_UPDATE / вікно «Що нового»
 ├─ Header → HeaderUpdateButton      (новий, у групі зі ConnectionBadge)
 ├─ WhatsNewOverlay                  (новий, повноекранний; джин у кнопку)
 └─ NativeAppUpdateNotice            (лишається вікно подробиць; плашка — лише fallback-и)
```

- **Авто-встановлення після завантаження.** `start()` для нативного каналу ставить прапорець «людина погодилась» у провайдері (у пам'яті вкладки). Коли знімок доходить до `prepared` і в `availableActions` є `accept`, провайдер сам викликає `act('accept')` один раз на `attemptId`. Згода дана натисканням «Оновити»; оновлювач і так чекає завершення роботи (draining) і сам перезапускає Soty. Якщо вкладку перезавантажили між завантаженням і встановленням — прапорця нема, кнопка в шапці показує «Встановити» (`available` з `canAccept`), одне натискання.
- **Інсталятор.** `start()` бере `resolveInstallerDownload(manifest, agentRuntime)`; якщо `available` — програмно відкриває URL (тимчасовий `<a href download>`), `markAgentInstallStarted()`, `update_started`, тост з підказкою. Якщо `choice-required` — відкриває вікно «Що нового», де є `InstallerDownload` з вибором процесора.
- **Вікно «Що нового»** — власний повноекранний шар на `useDialogBehaviour` (фокус-пастка, Escape, повернення фокусу) з `components/ui/Overlay.tsx`; не `Modal`, бо треба керувати виходом (джин) самому. Позначка «показано» — `localStorage['soty.whats-new.seen.v1'] = buildId` (try/catch).
- **Джин** (`apps/web/src/updates/genie.ts`) — Web Animations API на панелі вікна: ціль — `getBoundingClientRect()` кнопки `[data-update-button]`; кадри: 0 % — як є; 45 % — `translate(30 % шляху) scale(0.55, 0.9)` + `clip-path` трапеція, що звужується в бік кнопки; 100 % — `translate(до центру кнопки) scale(0.04, 0.08)`, `opacity: 0.3`. Тривалість і крива — токени `--motion-genie`, `--ease-genie` з `tokens.css`, прочитані через `getComputedStyle` (жодних чисел у TS). Затемнення згасає паралельно (`--motion-slow`). Після `finished` — подія `soty:update-button:glow`, кнопка ставить `data-glow` на `--motion-update-glow` (2 с). `prefers-reduced-motion` → токени й так 1 мс у блоці reduced-motion; плюс явна гілка: просте згасання.
- **Кнопка в шапці** (`apps/web/src/updates/HeaderUpdateButton.tsx`) — `Button`/`IconButton` з `components/ui`; значок `Download` (lucide), крапка — `::after` з токенами; кільце прогресу — `conic-gradient` з `--update-fraction` (custom property, значення ставиться inline-стилем як число, не колір). Тон `attention` — `color="warning"`. Ширина ≥ 640 px — підпис «Оновити», нижче — лише значок (CSS, як `connection-badge-text`).

## Файли

| Файл | Зміна |
| --- | --- |
| `apps/web/src/updates/UpdateCenter.tsx` | новий: провайдер, `useUpdateCenter()`, обчислення `offer`, `start()`, авто-accept |
| `apps/web/src/updates/HeaderUpdateButton.tsx` | нова кнопка |
| `apps/web/src/updates/WhatsNewOverlay.tsx` | нове вікно |
| `apps/web/src/updates/genie.ts` | анімація |
| `apps/web/src/updates/release-highlights.ts` | зміст «що нового» за версією + загальний запасний варіант |
| `apps/web/src/updates/update-center.css` | стилі (лише токени) |
| `apps/web/src/App.tsx` | `Header`: `<HeaderUpdateButton/>` після `ConnectionBadge` |
| `apps/web/src/ProtectedSoty.tsx` | `UpdateCenterProvider`, `WhatsNewOverlay` |
| `apps/web/src/components/NativeAppUpdateNotice.tsx` | бере стан із провайдера; плашка лише для fallback-ів |
| `apps/web/src/components/ReleaseUpdateNotice.tsx` | legacy-плашка лише для повернення на стабільну |
| `apps/web/src/styles/tokens.css` | `--motion-genie`, `--ease-genie`, `--motion-update-glow`, `--shadow-update-glow` + reduced-motion |
| `apps/web/src/locales/{uk,en}.ts` | тексти |
| `tests/update-center.test.tsx` | новий |

## Ризики

- Два читачі нативного стану на одній сторінці колись давали дубль SSE — тепер рівно один (провайдер). Меню користувача й «Кабінет» відкривають вікно подневою подією, як і раніше.
- Тести `release`/`native-app-update`, що шукають плашку внизу (`.release-update-notice`), треба переглянути: плашка тепер лише для fallback-ів.
- Джин на панелі з `overflow` і `clip-path` у Safari: перевірити в Chrome і Safari на беті; при помилці WAAPI — згасання.
