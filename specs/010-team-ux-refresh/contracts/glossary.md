# Contract: Interface Glossary (enforced)

The spec's «Термінологія» table, restated as the machine-checked contract behind
`tests/team-i18n-glossary.test.ts` (decision D11) and SC-007. Applies to every user-visible
team-mode string in both locales.

## Canonical vocabulary

| Concept | uk | en |
|---|---|---|
| The team object | Простір | Space |
| The mode / entry point | Командний простір | Team workspace |
| Content units | файл / папка (collective: файли) | file / folder (files) |
| Sections | Файли · Завдання · Креативи · Лендінги · Налаштування | Files · Tasks · Creatives · Landings · Settings |
| Creative stages | Finds / Library — shown as the physical folder names they are | Finds / Library |
| Long-running file work | Обробка | Processing |
| Close-only button | Закрити | Close |
| Cancel-an-action button | Скасувати | Cancel |

## Forbidden in user-visible team strings

- «Таски», «таск» (uk slang register) — use «Завдання».
- «матеріал(и)», "asset(s)", "media", "creative(s)" as *synonyms for files* in running copy.
  («Креативи» is the section name; inside it, items are still файли/files.)
- "team"/«команда» and "workspace"/«воркспейс» as the *object* noun — the object is
  Простір/Space. («Командний простір»/"Team workspace" names the mode, not the object.)
- "Library" as the name of the whole section (it names only the stage/folder).
- Any placeholder copy; specifically `ДОНТ ПУШ ЗЕ ХОРСИС` must not appear in any bundle.
- The Cancel string on close-only surfaces (key-role map in the test: viewer/preview/status
  overlays close; editors and running operations cancel).

## Key hygiene

- The duplicate keys `teamFileCancel` / `teamCreateCancel` collapse into `teamCancel`; a new
  `teamClose` covers close-only surfaces. Renames ride the compile-checked `TranslationKey`
  union so stale call sites fail the build.
- `teamWorkspaceGateTitle` gets real copy in **both** locales.
- One loading string per shape: list-loading vs single-item-loading are distinct keys
  (no reusing "Loading task…" for folder listings).

## Enforcement

`tests/team-i18n-glossary.test.ts` imports both bundles and asserts the forbidden list, the
canonical section labels, the gate-title replacement, and the Close/Cancel key-role map.
The test is part of `npm test` — the glossary cannot silently rot.
