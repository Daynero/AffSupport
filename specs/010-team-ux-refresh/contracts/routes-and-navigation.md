# Contract: Routes & Navigation

Extends the hand-rolled router (`apps/web/src/lib/navigation.ts`) — no router library.
`ProtectedSoty` matches the `/team` prefix and delegates to the team resolver.

## Address scheme

```
/team                          resolver (lobby / redirects / wizard resume)
/team?drive=…                  Drive OAuth return → resume owned mid-setup space (unchanged)
/team/<spaceId>                workspace — Files section (canonical default, no /files suffix)
/team/<spaceId>/tasks          Tasks
/team/<spaceId>/creatives      Creatives (bulk stages Finds/Library inside)
/team/<spaceId>/landings       Landings
/team/<spaceId>/settings       Space settings (members, invitations, drive, audit)
/team/<spaceId>/trash          Trash view (restore)
```

Query parameters (all optional, all restorable on refresh):

```
?q=<text>&geo=…&lang=…&…       Files search + filters (only meaningful on the Files section)
?task=<taskId>                 opens the task editor over the Tasks section
?folder=<materialId>           Files browser position
```

## Semantics

- **URL is truth.** Entering a space navigates; switching sections navigates; refresh
  restores space + section + query state; browser Back walks the in-team history before
  leaving the mode (SC-003).
- **Tabs are links** (`internalLink()`), marked with `aria-current="page"`; middle-click and
  copy-link work.
- **Remembered space** (device-local, unchanged key) only influences the bare `/team`
  redirect; it never overrides an explicit URL.
- **Access**: an unknown, denied, or departed space id renders one neutral no-access screen —
  byte-identical for "does not exist" and "not a member" (001 FR-016). No name, no counts.
- **Resolver order** (deterministic, D14): `?drive=` resume → URL space → pending
  invitations ⇒ lobby → exactly one `ready` space ⇒ redirect into it (`replace`) →
  remembered space ⇒ redirect → lobby.
- **Redirects** use `history.replaceState` so Back never bounces through them.
- **Wizard**: folder step exposes Back to the name step (state kept); Cancel returns to the
  lobby; completing creation lands in `/team/<newId>`.

## Non-goals

No cross-space search routes, no per-material permalinks (Drive links remain the sharing
mechanism), no route-level data preloading changes.
