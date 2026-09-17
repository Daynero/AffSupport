-- Feature 024 — events written in one transaction keep their order in the history.
--
-- `occurred_at` defaulted to now(), the transaction's start: a task made with its file attached
-- wrote "task created" and "file attached" at the same instant, and the history ordered them by
-- a random id — the attachment could read as happening first. clock_timestamp() is the moment
-- each event is written. ROLLBACK.md sets the default back to now().

alter table public.team_audit_events
  alter column occurred_at set default clock_timestamp();
