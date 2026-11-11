-- 1.4.3: a historical trash/restore receipt said when it was observed with
-- `'observedAt',statement_timestamp()` inside jsonb_build_object. A timestamptz
-- in jsonb is rendered with a numeric offset (`2026-11-11T13:45:28.311888+00:00`),
-- while every client accepts an instant only as UTC with `Z`. The receipt was
-- refused as malformed, and since list_team_bulk_trash carries it, the whole
-- list became INVALID_RESPONSE: no panel rendered and no new bulk trash could
-- start for anyone holding such a receipt (seen on beta 2026-11-11).
--
-- The receipt now spells the instant itself, in UTC with `Z` and microseconds,
-- independent of the session time zone. Every reader (the list, prepare,
-- start, drive-ops) goes through private.material_historical_receipt.
begin;

do $receipt$
declare d text;
begin
 select pg_get_functiondef('private.material_historical_receipt(uuid,uuid,uuid,uuid,text,uuid)'::regprocedure) into d;
 if strpos(d,$find$'observedAt',statement_timestamp(),$find$)=0 then raise exception 'HISTORICAL_RECEIPT_INSTANT_PATCH_MISSING'; end if;
 d:=replace(d,$find$'observedAt',statement_timestamp(),$find$,
  $replace$'observedAt',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),$replace$);
 execute d;
end $receipt$;

commit;
