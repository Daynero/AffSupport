/**
 * 064: what a tool card does when the person presses its button. Every row goes through the same
 * client call the screen for it uses — Accounts for money and ad-account tags, the explorer for
 * folders, moves, renames and the trash (with the video's transcript and catalogs following it),
 * Tasks, People — so the assistant can never do something a screen could not, nor do it
 * differently. The server prepared the rows with the versions it saw; a row changed since is
 * refused by the server and counted as failed, never overwritten.
 */
import { teamApi } from '../../api/team';
import { teamFinanceApi } from '../../api/team-finance';
import { accountsWorkspaceApi } from '../../api/team-accounts-workspace';
import { launchApi } from '../../api/launches';
import { moveWorkspaceMaterials } from '../explorer/moveCoordinator';
import {
  copyMaterialWithTail,
  renameMaterialWithTail,
  trashMaterialWithTail
} from '../materials/tail';
import { requireCompletedFileOperation } from '../materials/file-operation-outcome';
import type { FinanceMetric, MaterialMetadataPatch } from '@video-compressor/shared';

export interface ToolOutcome {
  done: number;
  failed: number;
  /** The first refusal's code, so the card can say why. */
  code: string | null;
}

type Row = Record<string, unknown> & { label: string };
type Payload = Record<string, unknown> & { tool: string; items?: Row[] };

const uuid = () => crypto.randomUUID();
const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNAVAILABLE';

/** Each row once; three at a time where the screen itself works in parallel. */
async function each(
  rows: readonly Row[],
  work: (row: Row, index: number) => Promise<unknown>,
  width = 1
): Promise<ToolOutcome> {
  const outcome: ToolOutcome = { done: 0, failed: 0, code: null };
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const index = next++;
      try {
        await work(rows[index]!, index);
        outcome.done++;
      } catch (error) {
        outcome.failed++;
        outcome.code ??= codeOf(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, rows.length) }, lane));
  return outcome;
}

/** Labels by name, creating the missing ones (a new tag goes on at once, as asked). */
async function labelIds(
  teamId: string,
  scope: 'task' | 'agent',
  wanted: Array<{ id: string | null; name: string }>
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const fold = (name: string) => name.toLocaleLowerCase('uk');
  wanted.forEach(tag => tag.id && ids.set(fold(tag.name), tag.id));
  // The same new tag on several rows is created once.
  const missing = [
    ...new Map(
      wanted.filter(tag => !ids.has(fold(tag.name))).map(tag => [fold(tag.name), tag])
    ).values()
  ];
  if (!missing.length) return ids;
  let known: Awaited<ReturnType<typeof teamApi.listTaskLabels>> | null = null;
  for (const tag of missing) {
    try {
      const created = await teamApi.createTaskLabel({
        teamId,
        name: tag.name,
        color: 'honey',
        scope
      });
      ids.set(fold(tag.name), created.id);
    } catch (error) {
      // Made in the meantime by someone else: use theirs.
      if (codeOf(error) !== 'NAME_CONFLICT') throw error;
      known ??= await teamApi.listTaskLabels(teamId, scope);
      const found = known.find(label => fold(label.name) === fold(tag.name));
      if (!found) throw error;
      ids.set(fold(tag.name), found.id);
    }
  }
  return ids;
}

const material = (row: Row) => ({
  id: String(row.id),
  name: row.label,
  category: typeof row.category === 'string' ? row.category : null
});

export async function runToolCard(
  teamId: string,
  cardId: string,
  payload: Payload
): Promise<ToolOutcome> {
  const rows = (payload.items ?? []) as Row[];
  switch (payload.tool) {
    case 'set_finance':
      return each(
        rows.filter(row => !row.unchanged),
        row =>
          teamFinanceApi.set(
            teamId,
            String(row.agentRowId),
            String(payload.date),
            payload.metric as FinanceMetric,
            String(row.to),
            String(row.version),
            String(payload.timezone),
            uuid(),
            String(row.placementId)
          )
      );
    case 'tag_ad_accounts': {
      const wanted = rows.flatMap(row => [
        ...((row.add as Array<{ id: string | null; name: string }>) ?? [])
      ]);
      const ids = await labelIds(teamId, 'agent', wanted);
      return each(rows, async row => {
        for (const tag of (row.add as Array<{ name: string }>) ?? [])
          await teamApi.attachAgentLabel({
            teamId,
            agentRowId: String(row.id),
            labelId: ids.get(tag.name.toLocaleLowerCase('uk'))!
          });
        for (const tag of (row.remove as Array<{ id: string }>) ?? [])
          await teamApi.detachAgentLabel({ teamId, agentRowId: String(row.id), labelId: tag.id });
      });
    }
    case 'create_folders': {
      const parent = payload.parent as {
        id?: string;
        create?: string;
        parentId?: string | null;
      } | null;
      let parentId = parent?.id ?? null;
      if (parent?.create) {
        const made = await teamApi.ensureUploadFolder(teamId, {
          name: parent.create,
          parentMaterialId: parent.parentId ?? null,
          idempotencyKey: `${cardId}:parent`
        });
        parentId = made.materialId;
      }
      return each(
        rows.filter(row => !row.exists),
        (row, index) =>
          teamApi.ensureUploadFolder(teamId, {
            name: String(row.name),
            parentMaterialId: parentId,
            idempotencyKey: `${cardId}:folder:${index}`
          })
      );
    }
    case 'restore_materials':
      return each(
        rows,
        (row, index) =>
          teamApi
            .restoreMaterial({
              teamId,
              materialId: String(row.id),
              idempotencyKey: `${cardId}:restore:${index}`
            })
            .then(requireCompletedFileOperation),
        3
      );
    case 'copy_materials': {
      const target = payload.destination as {
        root?: boolean;
        driveId?: string;
        create?: string;
        parentId?: string | null;
      };
      let destination: string | null = null;
      if (target.create) {
        const made = await teamApi.ensureUploadFolder(teamId, {
          name: target.create,
          parentMaterialId: target.parentId ?? null,
          idempotencyKey: `${cardId}:destination`
        });
        destination = made.folderId;
      } else if (!target.root) destination = target.driveId ?? null;
      return each(
        rows,
        row =>
          copyMaterialWithTail({
            teamId,
            material: material(row),
            destinationFolderId: destination,
            client: teamApi
          }).then(requireCompletedFileOperation),
        3
      );
    }
    case 'rename_accounts':
      return each(rows, row =>
        teamApi.renameAccount({ teamId, accountId: String(row.id), name: String(row.to) })
      );
    case 'add_ad_accounts': {
      const account = payload.account as { id: string };
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return each(
        rows.filter(row => !row.exists),
        row =>
          teamApi.addAccountAgent({
            teamId,
            accountId: account.id,
            agentId: String(row.agentId),
            timezone
          })
      );
    }
    case 'change_ad_account_ids':
      return each(rows, row =>
        teamApi.updateAccountAgent({ teamId, agentRowId: String(row.id), agentId: String(row.to) })
      );
    case 'archive_accounts':
    case 'restore_accounts': {
      // As Accounts does it: read the entity's lifecycle and token, then change it with them.
      const archived = payload.tool === 'archive_accounts';
      return each(rows, async row => {
        const kind = row.kind === 'social' ? 'social' : 'agent';
        const state = await accountsWorkspaceApi.preflight(teamId, kind, String(row.id));
        await accountsWorkspaceApi.archive(
          teamId,
          kind,
          String(row.id),
          archived,
          state.lifecycleVersion,
          state.token,
          uuid()
        );
      });
    }
    case 'catalog_interval': {
      try {
        await teamApi.setCatalogUpdateInterval(
          teamId,
          rows.map(row => String(row.id)),
          (payload.interval as Parameters<typeof teamApi.setCatalogUpdateInterval>[2]) ?? null
        );
        return { done: rows.length, failed: 0, code: null };
      } catch (error) {
        return { done: 0, failed: rows.length, code: codeOf(error) };
      }
    }
    case 'edit_offers':
      return each(rows, row =>
        launchApi.editDictionary(
          teamId,
          'offers',
          { id: String(row.id), value: row.label, updatedAt: String(row.updatedAt) },
          row.operation as 'rename' | 'archive' | 'restore',
          row.operation === 'rename' ? String(row.to) : row.label,
          uuid()
        )
      );
    case 'delete_tasks':
      return each(rows, row => teamApi.deleteTask({ teamId, taskId: String(row.id) }));
    case 'move_materials': {
      const target = payload.destination as {
        root?: boolean;
        driveId?: string;
        create?: string;
        parentId?: string | null;
      };
      let destination: string | null = null;
      if (target.create) {
        const made = await teamApi.ensureUploadFolder(teamId, {
          name: target.create,
          parentMaterialId: target.parentId ?? null,
          idempotencyKey: `${cardId}:destination`
        });
        destination = made.folderId;
      } else if (!target.root) destination = target.driveId ?? null;
      const moved = await moveWorkspaceMaterials({
        teamId,
        items: rows.map(material),
        destinationFolderId: destination,
        conflictMode: 'keep_both',
        client: teamApi
      });
      return {
        done: moved.completed,
        failed: rows.length - moved.completed,
        code: moved.error ? codeOf(moved.error) : null
      };
    }
    case 'rename_materials':
      return each(rows, row =>
        renameMaterialWithTail({
          teamId,
          material: material(row),
          newName: String(row.to),
          client: teamApi
        })
      );
    case 'edit_materials':
      return each(
        rows,
        row =>
          teamApi.updateMaterialMetadata(
            teamId,
            String(row.id),
            row.patch as MaterialMetadataPatch
          ),
        3
      );
    case 'trash_materials':
      return each(
        rows,
        (row, index) =>
          trashMaterialWithTail({
            teamId,
            material: material(row),
            client: teamApi,
            idempotencyKey: `${cardId}:trash:${index}`
          }),
        3
      );
    case 'trash_catalogs':
      return each(
        rows,
        (row, index) =>
          teamApi
            .trashMaterial({
              teamId,
              materialId: String(row.id),
              idempotencyKey: `${cardId}:catalog:${index}`
            })
            .then(requireCompletedFileOperation),
        3
      );
    case 'update_catalogs': {
      try {
        await teamApi.runCatalogUpdateNow(
          teamId,
          rows.map(row => String(row.id))
        );
        return { done: rows.length, failed: 0, code: null };
      } catch (error) {
        return { done: 0, failed: rows.length, code: codeOf(error) };
      }
    }
    case 'invite_members':
      return each(rows, row =>
        teamApi.createInvitation({
          teamId,
          email: String(row.email),
          initialRole: payload.role as 'admin' | 'editor' | 'viewer'
        })
      );
    case 'change_roles': {
      // The person's own extra rights stay as they were; only the role changes.
      const members = await teamApi.listMembers(teamId);
      return each(rows, row => {
        const member = members.find(candidate => candidate.userId === row.id);
        if (!member) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
        return teamApi.updateMembership({
          teamId,
          userId: member.userId,
          baseRole: payload.role as 'admin' | 'editor' | 'viewer',
          permissionOverrides: member.permissionOverrides
        });
      });
    }
    case 'remove_members':
      return each(rows, row => teamApi.removeMember(teamId, String(row.id)));
    case 'create_tasks': {
      const ids = await labelIds(
        teamId,
        'task',
        rows.flatMap(row => (row.tags as Array<{ id: string | null; name: string }>) ?? [])
      );
      // A task counts as made once it exists: pressing again must not make it twice. A day, tag
      // or file that did not attach is reported, not retried by making another task.
      let finishing: string | null = null;
      const made = await each(rows, async row => {
        const task = await teamApi.createTask({
          teamId,
          title: String(row.title),
          assigneeId: typeof row.assigneeId === 'string' ? row.assigneeId : null
        });
        try {
          if (typeof row.date === 'string')
            await teamApi.updateTask(teamId, task.id, { dateOn: row.date });
          for (const tag of (row.tags as Array<{ name: string }>) ?? [])
            await teamApi.attachTaskLabel({
              teamId,
              taskId: task.id,
              labelId: ids.get(tag.name.toLocaleLowerCase('uk'))!
            });
          const files = (row.materials as Array<{ id: string }>) ?? [];
          if (files.length)
            await teamApi.attachTaskMaterials({
              teamId,
              taskId: task.id,
              materialIds: files.map(file => file.id)
            });
        } catch (error) {
          finishing ??= codeOf(error);
        }
      });
      return { ...made, code: made.code ?? finishing };
    }
    case 'update_tasks': {
      const ids = await labelIds(
        teamId,
        'task',
        rows.flatMap(row => (row.tags as Array<{ id: string | null; name: string }>) ?? [])
      );
      return each(rows, async row => {
        const patch = (row.patch as Record<string, unknown>) ?? {};
        if (Object.keys(patch).length)
          await teamApi.updateTask(teamId, String(row.id), {
            ...patch,
            expectedUpdatedAt: String(row.expectedUpdatedAt)
          });
        for (const tag of (row.tags as Array<{ name: string }>) ?? [])
          await teamApi.attachTaskLabel({
            teamId,
            taskId: String(row.id),
            labelId: ids.get(tag.name.toLocaleLowerCase('uk'))!
          });
      });
    }
    default:
      return { done: 0, failed: rows.length, code: 'UNKNOWN_TOOL' };
  }
}
