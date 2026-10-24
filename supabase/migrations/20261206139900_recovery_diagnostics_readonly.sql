-- Supabase grants service_role table privileges by default, including on views.
-- Diagnosis must not provide a second write path into either private ledger.
begin;
revoke all on public.analytics_recovery_execution,public.analytics_process_output_cleanup
 from public,anon,authenticated,service_role;
grant select on public.analytics_recovery_execution,public.analytics_process_output_cleanup
 to service_role;
commit;
