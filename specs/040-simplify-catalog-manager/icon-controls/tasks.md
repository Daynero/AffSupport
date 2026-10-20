# Tasks: inline icon controls

The approved icon-controls/plan.md supersedes the previous draft editor model for individual catalog fields. Existing defaults and explicit bulk editing remain.

- [x] I001 Read plan, design rules, contracts and checklist (16/16 complete); preserve all existing profiles.
- [x] I002 Implement one versioned mutation controller with readback, conflict, rollback, pending lock and session undo.
- [x] I003 Build shared five-icon toolbar, legend and live detail controls.
- [x] I004 Integrate semantic compact table, visible next/last dates, inline schedule and run guards.
- [x] I005 Add quick bulk entry points, readiness handling, focus restoration and responsive tokens.
- [x] I006 Extend bounded diagnostic stages and coverage; regression tests for writes, unknown/conflict, undo and keyboard.
- [x] I007 Run verification and browser review; record actual evidence and pending user sessions.

Full-suite result and targeted correction evidence: [acceptance.md](acceptance.md). Full-suite success after the SQL correction is not claimed.

## Calendar schedule persistence amendment

- [x] S001 Add nullable schedule wire shape and atomic versioned SQL persistence/validation.
- [x] S002 Implement civil daily/weekly DST rules, retain legacy intervals and manual due times, and preserve worker authorization/reconciliation checks.
- [x] S003 Cover calendar/DST/version/permission/dispatch scenarios and expose current/frozen schedules in read-only diagnosis.
- [x] S004 Verify beta save/reopen and preview consistency in desktop Chrome; retain screenshots and SQL evidence for manual-run next-due preservation.
