# Benchmarks — 024

Each surface measured against the product that sets the bar in its field, with the pattern
borrowed or rejected and why. Kept as the work goes; the newest round is last.

## Round 1 (2026-09-16)

| Surface       | Reference              | What they do                                                                        | What we did                                                                                                     |
| ------------- | ---------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Task card     | Linear board           | Content-height cards; the title is what a card is read by; meta small               | No 300 px floor; title right under the status strip, progress after the brief                                   |
| Task editor   | Linear issue view      | Title is the heading, description is the body — no captions, no boxes until focused | Captions visually hidden; borderless title at section size and brief with a placeholder that says what to write |
| File grid     | Google Drive, Frame.io | Name, then one quiet line; the thumbnail already says what kind                     | Kind named only without a picture; `size · date` on one line; colour dot only when set                          |
| Files toolbar | Google Drive "New"     | One primary: putting files in                                                       | "Add files" primary; search and process secondary                                                               |
| Header        | Linear, Notion         | Space name, sections, one search, one menu of rare things                           | Done in 9D; kept                                                                                                |
| Empty states  | Linear, Airtable       | One invitation, no chrome over nothing                                              | Done in 9D; kept                                                                                                |

**Rejected:** Linear's single status icon with a menu on the card. A media buyer moves many
cards through three states a day; the one-press three-state pill stays, compact.
**Rejected:** middle-truncated file names (Finder). CSS cannot do it and a measured JS truncation
per tile costs more than the two-line clamp, which already keeps the distinguishing tail visible.

## Round 2 (2026-09-16)

| Surface         | Reference         | What they do                                                                                              | What we did                                                                                                                               |
| --------------- | ----------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| File list       | Google Drive list | Checkboxes appear on hover or once something is selected; row actions uncaptioned; no rules between cells | Box on hover/focus/any-checked (touch keeps it); "Actions" caption for screen readers only; cell rules gone                               |
| Command palette | Raycast, Linear   | Every row carries its type's icon and a grey line on the right saying what it is                          | Kind icons by category; "Video · 3.2 MB", a task's status; no size for Google documents; tasks are a checklist glyph, not a "create" plus |

## Round 3 (2026-09-16)

| Surface              | Reference                    | What they do                                     | What we did                                                                                                         |
| -------------------- | ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Catalog updater rows | Zapier / Make schedule lists | A row is its name, one status line, and one menu | Open the sheet inline, the rest in "…"; the meta line is where + last updated, the count and creation date on hover |
| Updater schedule     | the same                     | A schedule reads as one sentence                 | Presets and custom hours on one line                                                                                |

**Rejected:** Linear's neutral, hairline settings rows for space settings. The violet sections are
the compressor's settings panel, which the owner set as the reference for this product; one look
for "settings" across the product beats matching a different product.

## Round 4 (2026-09-16)

| Surface           | Reference              | What they do                                                                              | What we did                                                                                                                                                                    |
| ----------------- | ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File details pane | Google Drive "Details" | Name first; facts as small label–value rows; dates to the minute in the reader's language | Facts at label size under a body-size name (they had inherited a larger size and outranked the name); modified date as "15 вер. 2026 р., 18:49", no seconds, no machine locale |

## Round 5 (2026-09-16)

| Surface             | Reference              | What they do                                                                                                                       | What we did                                                                                                                                                                                                                                  |
| ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts table      | Airtable, Linear lists | A column is named once; one primary action per row, secondary ones on hover; bulk actions appear when there is something to act on | Money captions once per account, over its first agent; ± presses and a busy agent's "+ Run" on hover/focus (touch keeps them); the copy/clear bar only with figures in it; the "Agents:" caption and the "Actions" header text gone          |
| Accounts at 1001 px | —                      | —                                                                                                                                  | The narrow money width was set on the space while the table defined its own, so it never applied; moved onto the table, and the id and money tracks give the run line the room `check-accounts-layout.mjs` asked for. Green at all 17 widths |

## Round 6 (2026-09-16)

| Surface              | Reference                        | What they do                                                                    | What we did                                                                                                                                                                          |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Space picker (lobby) | Linear, Notion workspace pickers | One centred panel; the spaces are the choice; "create" is secondary, after them | A centred panel on its own ground (the heading had sat on the hexagons); spaces in one column; "Create a new space" secondary, under the list; the checking state on the same ground |
| Trash                | Google Drive trash               | A list of files; restore said quietly                                           | "Restore" as a quiet word instead of a bordered button on every row; the "Actions" header text for screen readers only                                                               |

## Round 7 (2026-09-16)

| Surface                  | Reference                  | What they do                                                                    | What we did                                                                                                                                                                                                                                                          |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shortcut sheet           | Linear                     | The action at reading size; each key its own keycap, which carries the row      | Labels at label size; one keycap per key ("⌘" "K", four arrows), raised with a heavier bottom edge                                                                                                                                                                   |
| Details pane, transcript | Google Drive details panel | A section's acts sit on one line, short, under a heading that names the subject | "View · Copy · Redo" as one row of small outlined controls with full names for screen readers. The rule that had boxed them targeted the pre-HeroUI class, so the migration left three bare words in a column — the exact look the rule's own comment warned against |
