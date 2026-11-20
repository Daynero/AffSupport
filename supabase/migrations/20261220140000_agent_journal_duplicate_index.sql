-- Backend audit 2026-11-20: public.agent_journal_records has had two identical indexes since
-- the table was created (20261124100000) — the unique constraint
-- agent_journal_records_instance_seq_key and the plain agent_journal_records_instance_seq_idx,
-- both btree (agent_instance_id, seq). Each is 20.5 MB on 294 000 rows, and every journal
-- record ingested writes both. The planner uses the unique one (389 396 scans against 52).
--
-- The plain copy goes. Reading a journal in order and refusing a repeated (instance, seq) are
-- both served by the constraint's index, exactly as before.
begin;

-- A statement that needs a lock on a table written many times a second must not wait for it
-- indefinitely: every writer queues behind a waiting DDL. Five seconds, then the whole file
-- fails cleanly and is applied again (as 20261218200000 does).
set local lock_timeout = '5s';

drop index if exists public.agent_journal_records_instance_seq_idx;

commit;
