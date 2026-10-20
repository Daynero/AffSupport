begin;
-- Revalidate the current permission at the last database boundary before provider work.
create function public.service_authorize_task_cleanup(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.task_attachment_cleanup c
 join private.task_owned_uploads u on u.material_id=c.material_id
 join public.team_materials m on m.id=c.material_id and m.team_id=c.team_id
 where c.id=p_id and c.state='claimed' and private.task_cleanup_coverage_verified()
 and not private.task_cleanup_has_reference(c.material_id,u.drive_file_id) and private.can(c.team_id,'delete',c.actor_id)
 and m.lifecycle='active' and m.drive_file_id=u.drive_file_id and m.parent_folder_id=u.parent_folder_id)
$$;
revoke all on function public.service_authorize_task_cleanup(uuid) from public,anon,authenticated;
grant execute on function public.service_authorize_task_cleanup(uuid) to service_role;

commit;
