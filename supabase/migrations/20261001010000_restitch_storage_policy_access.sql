-- Storage clients do not have SELECT on public.teams. Use the existing
-- security-definer permission check instead of querying that table as the caller.
-- CASE guards the cast for unrelated/malformed object names in this shared table.
alter policy team_restitch_images_read on storage.objects
using (
  bucket_id = 'team-restitch-images'
  and case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then private.can((storage.foldername(name))[1]::uuid, 'view', auth.uid())
    else false end
);

alter policy team_restitch_images_write on storage.objects
with check (
  bucket_id = 'team-restitch-images'
  and (storage.foldername(name))[2] = auth.uid()::text
  and case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then private.can((storage.foldername(name))[1]::uuid, 'view', auth.uid())
    else false end
);
