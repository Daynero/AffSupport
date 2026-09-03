# Feature Specification: 2FA Notebook

**Feature Branch**: `016-totp-notebook`

**Created**: 2026-09-03

**Status**: Draft

**Input**: User description: "треба як новий інструмент зробити записник 2фа токенів. це має бути простий не перегружений інструмент в стилістиці як компресор(маю наувазі кольори ікоки і тд). список в 1 строку. назва, токен 2фа(або просто написати 2fa) поряд кнопка копіювати(яка одразу копіює цей 2фа. далі кнопка згенерувати і копіювати код це в одному типу тицяїш, воно прописує код і тут ж в буфер обміну. вираховуємо 6тизначний код самі як це для 2фа робиться. зберігаємо список приватно в бд. також кнопка видалити іконкою і редагувати. зверху хакріплений пошук по імені або по 2фа."

## Overview

A new tool in the Soty catalogue: a private notebook of two-factor
authentication secrets. Someone who juggles many advertising, tracker and
partner accounts keeps their 2FA seeds in a text file or a password manager
that lives outside the daily workflow. This tool puts them one row apart from
the work: a name, the secret behind a copy button, and a single press that
turns the secret into the six-digit code already sitting in the clipboard.

Deliberately small, and personal: this version has one notebook per person,
with team-space sharing left to a later feature. It is a notebook, not a
password manager: no folders, no sharing UI, no history, no QR camera. It borrows the compressor's visual
language — the same palette, icon weight, card and row shapes — so it reads as
part of the same product rather than a bolted-on utility.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Keep a secret and hand it over (Priority: P1)

Someone opens the tool, adds an entry with a name ("Facebook — main BM") and
the 2FA secret they were given when the account's two-factor was enabled, and
saves it. The entry appears as one line in the list. Later, when a service or a
colleague's setup flow asks for the seed itself, they press the copy button on
that row and paste it.

**Why this priority**: Without stored, retrievable secrets there is no tool.
This story alone replaces the text file and already delivers value.

**Independent Test**: Add two entries, reload the page in a different browser
session as the same person, confirm both rows are there and that the copy
button puts the exact original secret on the clipboard.

**Acceptance Scenarios**:

1. **Given** an empty notebook, **When** the person adds an entry with a name
   and a valid secret, **Then** the entry appears as a single row showing the
   name, and the list persists across reloads and devices for that person only.
2. **Given** a row in the list, **When** the person presses its copy button,
   **Then** the stored secret is placed on the clipboard unchanged and a brief
   confirmation is shown.
3. **Given** the person types a secret that is not a valid 2FA seed, **When**
   they try to save, **Then** the entry is rejected with a message naming the
   problem and nothing is stored.
4. **Given** the person pastes a full `otpauth://` enrolment link instead of a
   bare secret, **When** they save, **Then** the secret is extracted from the
   link and the account label pre-fills the name field.

---

### User Story 2 - One press: code generated and copied (Priority: P2)

A login screen is waiting for a six-digit code. The person finds the row and
presses the generate-and-copy button. In one action the current code is written
into the row and placed on the clipboard; they switch to the login tab and
paste.

**Why this priority**: This is the everyday action and the reason the tool
beats a text file, but it depends on entries existing (P1).

**Independent Test**: With one stored entry whose secret is known, press
generate-and-copy and compare the shown code with a code produced by any
standard authenticator app for the same secret at the same moment.

**Acceptance Scenarios**:

1. **Given** a row with a stored secret, **When** the person presses
   generate-and-copy, **Then** a six-digit code appears on that row and the
   same code is on the clipboard, from one press.
2. **Given** a code was just generated, **When** the person looks at the row,
   **Then** they can tell how much of the code's validity window is left.
3. **Given** a shown code's validity window has expired, **When** the person
   looks at the row, **Then** the stale code is no longer presented as current.
4. **Given** the same secret at the same moment, **When** the code is generated
   here and in a standard authenticator application, **Then** the two codes are
   identical.

---

### User Story 3 - Find, correct, remove (Priority: P3)

The list has grown. A search field pinned to the top of the tool filters the
rows as the person types, matching either the name or the secret. A row's edit
button opens the same small form used for adding, so a name can be corrected or
a rotated secret replaced. A delete button removes an entry that belongs to a
closed account.

**Why this priority**: Housekeeping. It makes a long list usable but the tool
is already useful without it.

**Independent Test**: With a dozen entries, type a fragment of one name and one
secret in turn and confirm the list narrows to the matching rows; rename an
entry and delete another, then reload to confirm both changes stuck.

**Acceptance Scenarios**:

1. **Given** a list of entries, **When** the person types into the pinned
   search field, **Then** only entries whose name or secret contains the typed
   text remain visible, updating as they type.
2. **Given** the search field is pinned at the top, **When** the person scrolls
   a long list, **Then** the search field stays visible and usable.
3. **Given** a search that matches nothing, **When** the list is empty, **Then**
   an empty state explains that no entry matches, not that the notebook is empty.
4. **Given** a row, **When** the person presses its edit button, changes the
   name or the secret and saves, **Then** the row reflects the change and codes
   are generated from the new secret.
5. **Given** a row, **When** the person presses its delete button and confirms,
   **Then** the entry disappears from the list and is gone after a reload.

---

### Edge Cases

- **Clipboard refused.** The browser denies clipboard access or the page is not
  focused: the person is told the copy failed and the value is still shown so
  it can be selected by hand. A failed copy never looks like a success.
- **Wrong clock.** The device clock is minutes off, so generated codes are
  rejected by every service. The tool detects a clock far enough off to break
  codes and says so, rather than letting the person conclude their secrets are
  wrong.
- **Malformed or padded secrets.** Secrets arrive with spaces, lowercase
  letters or padding characters, as services print them. These are normalised
  and accepted; anything that is not a decodable seed is rejected on save.
- **Duplicate names.** Two entries may carry the same name; the tool does not
  block it, and both rows stay individually addressable.
- **Empty notebook.** The first visit shows an empty state that leads to adding
  the first entry, not a blank page.
- **A very long name.** A name longer than the row can show is truncated in the
  row and remains fully readable and searchable.
- **The list grows large.** Several hundred entries still search and scroll
  without the tool becoming sluggish.
- **Leaving the tool.** Navigating away or locking the screen does not leave a
  generated code sitting on screen indefinitely.

## Requirements _(mandatory)_

### Functional Requirements

#### Catalogue and shape

- **FR-001**: The notebook MUST appear as its own tool in the Soty tool
  catalogue, reachable by its own address, alongside the compressor and the
  other tools.
- **FR-002**: The tool MUST work without the local desktop application being
  installed, connected or running.
- **FR-003**: The tool MUST use the established visual language of the
  compressor — the same palette, icon style and weight, card and row shapes,
  and interaction feedback — and MUST NOT introduce a separate look.
- **FR-004**: Each entry MUST occupy a single row: name, the secret's
  presentation, a copy button, a generate-and-copy button, an edit button and a
  delete button. Edit and delete MUST be icon buttons, each carrying an
  accessible label.

#### Storing and access

- **FR-005**: Entries MUST be stored server-side so the same person sees the
  same notebook from any device and any browser they sign in from.
- **FR-006**: An entry MUST be readable, writable and deletable only by the
  person who owns it. The notebook is strictly personal in this version: there
  is no sharing, no team-space visibility and no administrative read path.
  Sharing 2FA inside a team space is a separate, later feature and MUST NOT be
  half-built here — but the entry MUST carry an owner in a way that a later
  team scope can extend without rewriting stored data.
- **FR-007**: Stored secrets MUST be held in the product's encrypted secret
  storage, the same protection already used for connected-account credentials,
  and MUST NOT sit as ordinary readable columns. A secret MUST leave that
  storage only for its owner's own session, through a narrow, purpose-built
  read path, and MUST NOT be readable by a broad table policy, by an
  administrator, or by any analytics route.
- **FR-008**: A secret MUST never appear in logs, analytics events, error
  reports or any URL.

#### Entry management

- **FR-009**: A person MUST be able to add an entry by giving a name and a
  secret. A name MUST be required and a secret MUST be required.
- **FR-010**: The tool MUST accept a secret pasted either as a bare seed or as
  a full `otpauth://` enrolment link, extracting the seed — and, when present,
  the label — from the link.
- **FR-011**: The tool MUST normalise the entered secret (whitespace, letter
  case, padding) and MUST reject on save anything that cannot serve as a 2FA
  seed, stating why.
- **FR-012**: A person MUST be able to edit an entry's name and secret, and to
  delete an entry. Deletion MUST require a confirmation and MUST be permanent.
- **FR-013**: The list MUST be ordered predictably and stably, so a row does
  not move under the pointer between visits.

#### Copying and code generation

- **FR-014**: A row's copy button MUST place that entry's stored secret on the
  clipboard in one press, unchanged from what was saved.
- **FR-015**: A row's generate-and-copy button MUST, from a single press,
  compute the current six-digit code, display it on that row, and place it on
  the clipboard.
- **FR-016**: Codes MUST be computed by the standard time-based one-time
  password rules, so that a code produced here is identical to the code a
  standard authenticator application produces from the same secret at the same
  moment.
- **FR-017**: A displayed code MUST convey how much of its validity window
  remains, and MUST stop being presented as current once that window has passed.
- **FR-018**: Every copy action MUST give immediate visible confirmation, and a
  failed copy MUST be reported as a failure with the value left available to
  copy by hand.

#### A code for a key that is not stored

- **FR-025**: A field pinned above the list MUST accept a 2FA key — bare or as
  an `otpauth://` link — and produce its current code, for a key that is not in
  the wallet and is not being added to it. It MUST be present at all times, not
  behind a control that has to be found first: the moment it is needed is not a
  moment to go looking for it.
- **FR-026**: Nothing entered there MUST be stored: it never reaches the
  database, and it is gone when the bar is closed.
- **FR-027**: That code MUST reach the clipboard from the same single press, and
  MUST show its remaining validity like any other, so the two paths to a code
  behave identically.

#### Search

- **FR-019**: A search field MUST be pinned to the top of the tool and MUST
  remain visible while a long list is scrolled.
- **FR-020**: Search MUST filter the list as the person types, matching against
  both the entry name and the entry's secret, case-insensitively.
- **FR-021**: A search that matches nothing MUST show an empty state distinct
  from the empty state of a notebook with no entries.

#### The codes themselves

- **FR-031**: Every account MUST show its current code at rest, without being
  asked. The code is the reason the tool exists; a wallet that hides it behind a
  press spends its whole screen on waiting.
- **FR-032**: All codes on the page MUST turn over together under one shared
  countdown, placed so it plainly governs them. A countdown per row would be the
  same number repeated once per account.
- **FR-033**: Pressing a code MUST copy it. It MUST NOT need a separate button:
  the digits are the target.
- **FR-034**: After a period with no interaction the codes MUST become
  unreadable, and any interaction MUST restore them. Codes may be on screen
  because they expire in thirty seconds and are single-use — unlike the keys,
  which stay hidden — but a wallet left open on a shared desk is still a wallet
  left open.

#### Presentation of the secret

- **FR-022**: A row MUST NOT show the secret at all in its resting state. The
  secret is not a column: the list stays one line per account, and a screen full
  of seeds is never on display in an office or on a shared screen.
- **FR-023**: A row MUST offer an explicit reveal that shows that one entry's
  secret in place, so a person can check a seed by eye against the service that
  issued it. Revealing MUST be per-entry and MUST NOT persist: leaving the tool
  or reloading hides every secret again. It MAY live behind the row's overflow
  menu, since it is not a daily action.
- **FR-024**: Copying the secret MUST NOT require revealing it first.

#### Presentation

- **FR-028**: The list MUST be a table of accounts — a name, its code and its
  actions on one line — and the codes MUST form a column with a shared edge, so
  the list can be scanned rather than read.
- **FR-028a**: The tool's width MUST be capped rather than filling any display:
  two meaningful columns do not improve with a wider monitor, they only move
  further apart than the eye can carry a row.
- **FR-029**: Accounts MUST be sortable by name in both directions and by when
  they were added.
- **FR-030**: Rows MUST be selectable, and a selection MUST offer to delete
  every account in it at once, with the same confirmation a single deletion asks
  for.

### Key Entities

- **2FA entry**: One stored credential in one person's notebook. Carries a
  human-given name, the protected secret, and the timestamps of its creation
  and last change. Belongs to exactly one owner.
- **Generated code**: The six-digit value derived from an entry's secret and
  the current time. Transient — shown on the row and placed on the clipboard,
  never stored.
- **Notebook**: The collection of entries belonging to one owner; the unit that
  search filters and that access rules protect.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: From an open notebook, a person gets a valid six-digit code onto
  the clipboard in one press and under 2 seconds.
- **SC-002**: Codes generated by the tool match those from a standard
  authenticator application for the same secret in 100% of checks across a full
  day, on a device whose clock is correct.
- **SC-003**: Adding a first entry — from opening the tool to seeing the saved
  row — takes under 30 seconds for someone who has the secret to hand.
- **SC-004**: In a notebook of 200 entries, typing three characters into the
  search field narrows the list within 300 ms.
- **SC-005**: A person signed in on a second device sees the identical
  notebook, with no manual export or import step.
- **SC-006**: Someone who is not the entry's owner cannot read its secret
  through any route the product exposes; verified by an authorization test per
  read, write and delete path.
- **SC-007**: A secret appears in no log line, analytics event or URL across a
  full add–copy–generate–edit–delete run; verified by inspection of captured
  output.
- **SC-008**: A first-time user completes add, copy secret and generate code
  without guidance or documentation.
- **SC-009**: With ten entries stored, a screenshot of the tool taken straight
  after opening it contains no readable secret; a secret becomes visible only
  after an explicit per-entry reveal.

## Assumptions

- The tool serves signed-in people only; the existing sign-in and identity of
  the product is reused and no new account concept is introduced.
- This version is a personal tool only. Team-space 2FA — shared entries,
  member permissions, an audit of who took which code — is a later feature and
  is deliberately not designed, not stubbed and not partially built here; the
  ownership of an entry is simply recorded so that a later team scope can be
  added beside it.
- Codes follow the ubiquitous defaults — six digits, a thirty-second window,
  the standard hashing choice — which is what services issuing these secrets
  expect. Per-entry customisation of digits, period or algorithm is out of
  scope for this version.
- Scanning a QR code with a camera is out of scope; secrets arrive by paste,
  either as a seed or as an enrolment link.
- Import and export of the notebook as a file, sharing UI, folders, tags and
  usage history are out of scope for this version.
- The tool is a browser tool; it does not involve the local desktop agent, its
  contract or its capabilities.
- Like other tools that are still being finished, this one may ship behind the
  product's existing development-acknowledgement gate until it is released.
- Codes are computed from the device's clock; no time server is contacted.
- The interface follows the product's existing language handling, with copy
  written in the product's established tone.
