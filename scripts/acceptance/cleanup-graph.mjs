/** Initial cleanup supports empty fixtures only. Unknown references are blockers, not cascades. */
export async function inspectCleanupGraph(db, ownership) {
  const started = Date.now();
  const actorIds = ownership.actors.map(actor => actor.id);
  const emails = ownership.actors.map(actor => actor.email);
  const blockers = [];
  const add = (code, table) => blockers.push({ code, ...(table ? { table } : {}) });
  const teams = (
    await db.query(
      'select id,name,owner_id from public.teams where owner_id=any($1::uuid[]) or id=any($2::uuid[])',
      [actorIds, ownership.expectedTeams.map(t => t.id).filter(Boolean)]
    )
  ).rows;
  for (const team of teams) {
    const expected = ownership.expectedTeams.find(
      t => t.ownerId === team.owner_id && t.name === team.name
    );
    if (!expected || (expected.id && expected.id !== team.id)) add('unexpected_team');
  }
  const teamIds = teams.map(t => t.id);
  const knownTeams = [
    ...new Set([
      ...teamIds,
      ...ownership.expectedTeams.map(t => t.id).filter(Boolean),
      ...(ownership.retiredTeamIds ?? [])
    ])
  ];
  const tariffs = (
    await db.query(
      'select id,owner_id,owner_email::text,team_id,note,granted_by,source,external_ref from public.space_tariffs where owner_id=any($1::uuid[]) or lower(owner_email::text)=any($2::text[]) or team_id=any($3::uuid[]) or id=any($4::uuid[])',
      [actorIds, emails, knownTeams, ownership.retiredTariffIds ?? []]
    )
  ).rows;
  for (const tariff of tariffs) {
    const owner = ownership.actors.find(
      a => a.id === tariff.owner_id && a.email === tariff.owner_email
    );
    if (
      !owner ||
      tariff.note !== ownership.namespace ||
      tariff.granted_by !== ownership.adminId ||
      tariff.source !== 'manual' ||
      tariff.external_ref !== null ||
      (tariff.team_id !== null && !teamIds.includes(tariff.team_id))
    )
      add('unexpected_tariff');
  }
  const tariffIds = tariffs.map(t => t.id);
  const storage = await db.query('select exists(select 1 from storage.objects) present');
  if (storage.rows[0]?.present) add('storage_cleanup_unsupported');
  const audit = (
    await db.query(
      'select actor_id,actor_label_snapshot,action,target,result from public.team_audit_events where team_id=any($1::uuid[])',
      [teamIds]
    )
  ).rows;
  for (const row of audit) {
    const actor = ownership.actors.find(a => a.id === row.actor_id);
    if (
      !actor ||
      row.actor_label_snapshot !== `036 ${actor.alias}` ||
      row.action !== 'team.created' ||
      row.result !== 'succeeded' ||
      !emptyObject(row.target)
    )
      add('populated_audit_unsupported');
  }
  const events = (
    await db.query(
      'select actor_id,team_id,kind,before,after from public.space_tariff_events where tariff_id=any($1::uuid[])',
      [tariffIds]
    )
  ).rows;
  for (const row of events)
    if (!emptyTariffEvent(row, ownership, teamIds)) add('populated_tariff_history_unsupported');
  const tables = (
    await db.query(
      "select n.nspname schema,c.relname name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p') order by n.nspname,c.relname"
    )
  ).rows;
  if (tables.length > 512) throw new Error('ACCEPTANCE_CLEANUP_SCAN_LIMIT');
  const needles = [
    ...new Set([
      ...actorIds,
      ...emails,
      ...knownTeams,
      ...tariffIds,
      ...(ownership.retiredTariffIds ?? [])
    ])
  ];
  const counts = [];
  for (const { schema, name } of tables) {
    if (Date.now() - started > 30000) throw new Error('ACCEPTANCE_CLEANUP_SCAN_LIMIT');
    if (!/^[a-z_][a-z0-9_]*$/.test(schema) || !/^[a-z_][a-z0-9_]*$/.test(name))
      throw new Error('ACCEPTANCE_CLEANUP_SCHEMA_UNKNOWN');
    const table = `${schema}.${name}`;
    let allowed = 'false';
    if (table === 'public.teams') allowed = 'candidate.id=any($2::uuid[])';
    if (table === 'public.profiles') allowed = 'candidate.id=any($4::uuid[])';
    if (table === 'public.admin_users') allowed = 'candidate.user_id=any($4::uuid[])';
    if (['public.team_members', 'public.team_membership_access_signals'].includes(table))
      allowed = 'candidate.team_id=any($2::uuid[]) and candidate.user_id=any($4::uuid[])';
    if (table === 'public.team_audit_events')
      allowed = 'candidate.team_id=any($2::uuid[]) and candidate.actor_id=any($4::uuid[])';
    if (table === 'public.space_tariffs') allowed = 'candidate.id=any($3::uuid[])';
    if (table === 'public.space_tariff_events')
      allowed =
        'candidate.tariff_id=any($3::uuid[]) and candidate.actor_id=any($4::uuid[]) and (candidate.team_id is null or candidate.team_id=any($2::uuid[]))';
    // All identifiers are closed pg_catalog metadata, values are bound. No row content escapes.
    const rows = await db.query(
      `select count(*)::int matched,count(*) filter(where not (${allowed}))::int blocked from "${schema}"."${name}" candidate where exists(select 1 from unnest($1::text[]) needle where position(needle in to_jsonb(candidate)::text)>0) and cardinality($2::uuid[])>=0 and cardinality($3::uuid[])>=0 and cardinality($4::uuid[])>=0`,
      [needles, teamIds, tariffIds, actorIds]
    );
    const result = rows.rows[0];
    if (result.matched) counts.push({ table, rows: result.matched });
    if (result.blocked) add('foreign_or_populated_reference', table);
  }
  return {
    ok: blockers.length === 0,
    blockers: blockers.slice(0, 32),
    blockerCount: blockers.length,
    teamIds,
    tariffIds,
    actorIds,
    counts,
    scope: 'empty-fixtures-only'
  };
}

function emptyObject(value) {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
  );
}
export function emptyTariffEvent(row, ownership, teamIds) {
  if (
    !ownership.actors.some(a => a.id === row.actor_id) ||
    row.before !== null ||
    (row.team_id !== null && !teamIds.includes(row.team_id)) ||
    !row.after ||
    typeof row.after !== 'object' ||
    Array.isArray(row.after)
  )
    return false;
  if (row.kind === 'bound')
    return (
      Object.keys(row.after).join(',') === 'teamId' &&
      teamIds.includes(row.after.teamId) &&
      row.team_id === row.after.teamId
    );
  return (
    row.kind === 'granted' &&
    Object.keys(row.after).sort().join(',') ===
      'endsOn,externalRef,extraSeats,note,notify,planCode,revokedAt,teamId' &&
    ['solo', 'lead'].includes(row.after.planCode) &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.after.endsOn) &&
    row.after.note === ownership.namespace &&
    row.after.externalRef === null &&
    row.after.revokedAt === null &&
    row.after.notify === false &&
    row.after.extraSeats === 0 &&
    row.after.teamId === row.team_id
  );
}
