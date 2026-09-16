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
