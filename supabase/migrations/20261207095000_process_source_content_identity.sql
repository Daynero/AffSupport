-- A Drive metadata revision is not a binary content revision. Use a known MD5
-- for process sources; retain strict versions for uploads/edits and unknown bytes.
do $migration$
declare definition text;
 needle text := 'source.drive_file_id is distinct from intent_row.expected_source_drive_file_id
      or source.drive_version is distinct from intent_row.expected_source_version
      or source.checksum is distinct from intent_row.expected_source_checksum';
 replacement text := 'source.drive_file_id is distinct from intent_row.expected_source_drive_file_id
      or source.checksum is distinct from intent_row.expected_source_checksum
      or (source.drive_version is distinct from intent_row.expected_source_version
          and not (operation_row.kind = ''process''
            and coalesce(intent_row.expected_source_checksum ~ ''^[a-f0-9]{32}$'',false)
            and source.checksum = intent_row.expected_source_checksum))';
begin
 definition := pg_get_functiondef('public.service_finalize_uploaded_material(uuid,uuid,jsonb)'::regprocedure);
 if position(needle in definition)=0 then raise exception 'Process content identity seam changed';end if;
 execute replace(definition,needle,replacement);
end $migration$;
