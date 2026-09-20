# Findings — 024, the flows pass (US10–US14)

What walking the journeys on the beta found that neither the spec nor the tests had, and what
was done about each. Written while the work was fresh; the sweep (T140–T148) adds to it.

## Found by walking, fixed

| Where                        | What was wrong                                                                                                                         | Fix                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Trash from Tasks             | Drawn _under_ the task board; its back button did nothing (the shell ignored the explorer's reports while another section was visible) | The trash stands in for the section, its reports are accepted, the button names where it returns |
| Header                       | Links with no ground vanished over a lit hexagon; later the tabs did too                                                               | Utilities, name and tabs on one panel                                                            |
| Document title               | Never set by the workspace, so the tab read "Soty — Tools" from the home page                                                          | `section · space — Soty`                                                                         |
| Task editor                  | Two columns chosen by the _window_ width inside a 624 px dialog; status pills broken into vertical letters                             | Container queries on the editor's own frame; a select below 460 px                               |
| Every inventory `Select`     | A select holding a value drew an empty trigger: HeroUI's list item wraps its children, so React Aria could not derive `textValue`      | `textValue` set on every item; `tests/select-shows-value.test.tsx`                               |
| Long-work panel              | On `--layer-overlay`, under every dialog — invisible exactly where a task's run is watched                                             | `--layer-work: 77`                                                                               |
| "Show in folder" from a task | The editor, portalled to the page, floated over Files                                                                                  | The editor opens only while Tasks is visible; the open task is remembered                        |
| "Add to a task…"             | Asked `list_team_tasks` for 200 rows; the function refuses above 100                                                                   | 100                                                                                              |
| Folder tree                  | Folder glyph on a line of its own above each name                                                                                      | Kind icons are inline; lucide icons in text are inline globally                                  |
| Only member, owner           | Told to transfer ownership to "a member in the list above"                                                                             | A sentence for the owner who is alone                                                            |
| Board on a phone             | Six lines of controls before the first card                                                                                            | Three                                                                                            |

## Decided against the spec, with the reason

- **Delete a task with Undo (FR-088)** — withdrawn. 021 finding R3 already established that a
  task cannot be re-created with its attachments, accounts and progress; an undo that restores
  less than it took is worse than a confirmation. Delete moved into the editor's menu and confirms.
- **Delete the registry's `compress` (T152)** — reversed. The contract always meant it to enqueue
  on a space-level queue; T149 made that queue, so it is wired instead.

## Known limits

- **A reload during a run loses the result's way back to its task.** The run finishes on the
  local app and the file is written, but the space queue that remembered `attachTo` lived in the
  page. Seen once on the beta (a stylesheet hot-reload mid-transcription). Persisting pending
  hand-offs would need a durable record of them; left as is, because the output is still where
  the video is and "Add to a task…" puts it on in two presses.
- **`tests/landing-preview-catalog.test.ts`** asserts peak render concurrency against
  `availableParallelism() - 2`; under load on this machine it measures 2 instead of 4. Agent
  code, untouched by 024.
