import { launchFailure } from '../_shared/launch-failures.ts';
import { parseCatalogRowRecipe } from '../_shared/product-catalog.ts';
import type { XlsxCell } from '../_shared/xlsx.ts';
import type { ServiceRpcClient } from '../_shared/credentials.ts';
import { isRecord } from '../_shared/validation.ts';
import { TeamFunctionError } from '../_shared/errors.ts';
import type { GoogleDriveClient, DriveFileMetadata } from '../_shared/drive.ts';
import {
  createProductCatalog,
  parseCreateProductCatalogRequest,
  type ProductCatalogDeps,
  type CreateProductCatalogResult
} from './product-catalog.ts';

export type DurableCatalogDrive = Pick<
  GoogleDriveClient,
  | 'listAnyonePermissions'
  | 'createAnyoneReaderPermission'
  | 'createConvertedFile'
  | 'updateFileMetadata'
  | 'getFile'
  | 'findCatalogIntentFiles'
>;
export interface CatalogIntent {
  id: string;
  variant: number;
  state: string;
  fence: string;
  attempt: number;
  checkpoint: Record<string, unknown>;
  result: unknown;
  operationId: string | null;
}
export interface CatalogIntentStore {
  resources?: (intent: CatalogIntent, owner: string) => Promise<Record<string, unknown>>;
  completed?: (intent: CatalogIntent) => Promise<CreateProductCatalogResult | null>;
  operation?: (
    intent: CatalogIntent
  ) => Promise<{ state: string; materialId: string | null } | null>;
  retryChild?: (intent: CatalogIntent, owner: string) => Promise<number>;

  begin(payload: Record<string, unknown>, owner: string): Promise<CatalogIntent>;
  checkpoint(
    intent: CatalogIntent,
    owner: string,
    state: string,
    patch: Record<string, unknown>,
    operationId?: string,
    result?: CreateProductCatalogResult
  ): Promise<void>;
  permission(
    intent: CatalogIntent,
    owner: string,
    fileId: string,
    credentialId: string,
    permissionId: string | null,
    state: 'pending' | 'created' | 'preserved'
  ): Promise<void>;
}
export function catalogIntentStore(
  service: ServiceRpcClient,
  teamId: string,
  videoId: string,
  actorId: string,
  key: string
): CatalogIntentStore {
  const call = async (name: string, parameters: Record<string, unknown>) => {
    const { data, error } = await service.rpc(name, parameters);
    if (error)
      throw new TeamFunctionError(
        error.message === 'REQUEST_REUSE_CONFLICT'
          ? 'REQUEST_REUSE_CONFLICT'
          : error.message === 'LEASE_MISMATCH'
            ? 'LEASE_MISMATCH'
            : error.message === 'PERMISSION_DENIED'
              ? 'PERMISSION_DENIED'
              : error.message === 'WRONG_STATE'
                ? 'WRONG_STATE'
                : 'GROUP_RECONCILING',
        { retryable: true }
      );
    return data;
  };
  const common = (intent: CatalogIntent, owner: string) => ({
    p_team: teamId,
    p_intent: intent.id,
    p_actor: actorId,
    p_owner: owner,
    p_fence: intent.fence
  });
  return {
    async resources(intent, owner) {
      const value = await call('service_plan_catalog_resources', common(intent, owner));
      if (!isRecord(value)) throw new TeamFunctionError('INVALID_RESPONSE');
      intent.checkpoint = { ...intent.checkpoint, ...value };
      return value;
    },
    async completed(intent) {
      const value = await call('service_reconcile_catalog_result', {
        p_team: teamId,
        p_intent: intent.id,
        p_actor: actorId
      });
      if (value === null) return null;
      const result = existingResult(value);
      if (!result) throw new TeamFunctionError('INVALID_RESPONSE');
      return result;
    },
    async operation(intent) {
      if (!intent.operationId) return null;
      const value = await call('service_get_team_operation', {
        p_operation: intent.operationId,
        p_actor: actorId
      });
      const row = Array.isArray(value) ? value[0] : value;
      if (
        !isRecord(row) ||
        row.team_id !== teamId ||
        row.source_material_id !== videoId ||
        typeof row.state !== 'string' ||
        (row.result_material_id !== null && typeof row.result_material_id !== 'string')
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return { state: row.state, materialId: row.result_material_id };
    },
    async retryChild(intent, owner) {
      const n = await call('service_retry_catalog_child', common(intent, owner));
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 2)
        throw new TeamFunctionError('INVALID_RESPONSE');
      intent.attempt = n;
      intent.operationId = null;
      return n;
    },
    async begin(payload, owner) {
      const r = await call('service_begin_catalog_intent', {
        p_team: teamId,
        p_video: videoId,
        p_actor: actorId,
        p_key: key,
        p_payload: payload,
        p_owner: owner
      });
      if (
        !isRecord(r) ||
        typeof r.id !== 'string' ||
        typeof r.variant !== 'number' ||
        typeof r.state !== 'string' ||
        typeof r.fence !== 'string' ||
        typeof r.attempt !== 'number' ||
        !isRecord(r.checkpoint) ||
        (r.operationId !== null && typeof r.operationId !== 'string')
      )
        throw new TeamFunctionError('INVALID_RESPONSE');
      return {
        id: r.id,
        variant: r.variant,
        state: r.state,
        fence: r.fence,
        attempt: r.attempt,
        checkpoint: r.checkpoint,
        result: r.result,
        operationId: r.operationId
      };
    },
    async checkpoint(intent, owner, state, patch, operationId, result) {
      await call('service_checkpoint_catalog_intent', {
        ...common(intent, owner),
        p_state: state,
        p_checkpoint: patch,
        p_operation: operationId ?? null,
        p_result: result ?? null
      });
      intent.state = state;
      intent.checkpoint = { ...intent.checkpoint, ...patch };
      if (operationId) intent.operationId = operationId;
    },
    async permission(intent, owner, fileId, credentialId, permissionId, state) {
      await call('service_record_catalog_permission', {
        ...common(intent, owner),
        p_file: fileId,
        p_credential: credentialId,
        p_permission: permissionId,
        p_prior_anyone: state === 'preserved',
        p_state: state
      });
    }
  };
}
function existingResult(value: unknown): CreateProductCatalogResult | null {
  if (
    !isRecord(value) ||
    (value.outcome !== 'created' &&
      value.outcome !== 'recreated' &&
      value.outcome !== 'existing') ||
    typeof value.videoShared !== 'boolean' ||
    !isRecord(value.catalog)
  )
    return null;
  const c = value.catalog;
  if (
    typeof c.materialId !== 'string' ||
    typeof c.name !== 'string' ||
    typeof c.sheetUrl !== 'string' ||
    typeof c.sourceLink !== 'string' ||
    typeof c.productCount !== 'number' ||
    (c.createdAt !== null && typeof c.createdAt !== 'string') ||
    (c.variant !== undefined && typeof c.variant !== 'number')
  )
    return null;
  return {
    outcome: value.outcome,
    videoShared: value.videoShared,
    catalog: {
      materialId: c.materialId,
      name: c.name,
      sheetUrl: c.sheetUrl,
      sourceLink: c.sourceLink,
      productCount: c.productCount,
      createdAt: c.createdAt,
      ...(typeof c.variant === 'number' ? { variant: c.variant } : {})
    }
  };
}
/** Decorates the existing generator; no second rows/template/XLSX implementation. */
export async function createDurableProductCatalog(
  deps: ProductCatalogDeps,
  store: CatalogIntentStore,
  fullDriveFor: (credentialId: string) => Promise<DurableCatalogDrive>,
  body: unknown,
  actor: string
): Promise<CreateProductCatalogResult> {
  const request = parseCreateProductCatalogRequest(body);
  const owner = crypto.randomUUID();
  const intent = await store.begin({ ...request }, owner);
  if (intent.state === 'registered') {
    const result = existingResult(intent.result);
    if (!result) throw new TeamFunctionError('INVALID_RESPONSE');
    return result;
  }
  try {
    const recovered = await store.completed?.(intent);
    if (recovered) {
      await store.checkpoint(intent, owner, 'registered', {}, undefined, recovered);
      return recovered;
    }
    let child = (await store.operation?.(intent)) ?? null;
    if (child?.state === 'canceled') throw new TeamFunctionError('WRONG_STATE');
    if (child?.state === 'failed') {
      if (!store.retryChild) throw new TeamFunctionError('WRONG_STATE');
      await store.retryChild(intent, owner);
      child = null;
    }
    let resources: Promise<Record<string, unknown>> | undefined;
    const ensureResources = async () => {
      if (store.resources) {
        resources ??= store.resources(intent, owner);
        await resources;
      }
    };
    const check = () =>
      store.checkpoint(
        intent,
        owner,
        intent.state === 'interrupted' ? 'planning' : intent.state,
        {}
      );
    const recoverFile = async (
      parentId: string,
      credentialId: string
    ): Promise<DriveFileMetadata | null> => {
      if (
        typeof intent.checkpoint.providerFileId !== 'string' &&
        intent.checkpoint.createStarted !== true
      )
        return null;
      await check();
      if (
        intent.checkpoint.parentId !== parentId ||
        intent.checkpoint.credentialId !== credentialId
      )
        throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
      const drive = await fullDriveFor(credentialId);
      const persisted = typeof intent.checkpoint.providerFileId === 'string';
      const matches = persisted
        ? [await drive.getFile(String(intent.checkpoint.providerFileId))]
        : await drive.findCatalogIntentFiles({ marker: intent.id, parentId });
      if (matches.length !== 1)
        throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN', { retryable: true });
      const file = matches[0];
      if (
        file.trashed ||
        file.mimeType !== 'application/vnd.google-apps.spreadsheet' ||
        !file.parents.includes(parentId) ||
        file.appProperties['soty.catalog.intent'] !== intent.id
      )
        throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
      if (!persisted) {
        const parent = await drive.getFile(parentId);
        if (
          file.driveId
            ? parent.driveId !== file.driveId || !file.capabilities.canModifyContent
            : file.ownedByMe !== true
        )
          throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
      }
      await store.checkpoint(intent, owner, 'created', { providerFileId: file.id });
      return file;
    };
    const wrapped: ProductCatalogDeps = {
      ...deps,
      preserveUncertainOutput: true,
      failOperation: (id, cause) => deps.failOperation(id, launchFailure(cause)),
      readCreatedFile: recoverFile,
      async readSettings(team) {
        if (request.idempotencyKey.startsWith('launch:')) await ensureResources();
        const known = intent.checkpoint.settings;
        if (known !== undefined) {
          if (
            !isRecord(known) ||
            (known.title !== null && typeof known.title !== 'string') ||
            (known.description !== null && typeof known.description !== 'string') ||
            (known.imageLink !== null && typeof known.imageLink !== 'string') ||
            typeof known.priceMin !== 'number' ||
            typeof known.priceMax !== 'number'
          )
            throw new TeamFunctionError('INVALID_RESPONSE');
          return {
            title: known.title,
            description: known.description,
            imageLink: known.imageLink,
            priceMin: known.priceMin,
            priceMax: known.priceMax
          };
        }
        const settings = await deps.readSettings(team);
        if (settings) await store.checkpoint(intent, owner, intent.state, { settings });
        return settings;
      },
      async rememberRowRecipe(rows) {
        if (intent.checkpoint.rowRecipe !== undefined) {
          const known = parseCatalogRowRecipe(intent.checkpoint.rowRecipe);
          if (!known) throw new TeamFunctionError('INVALID_RESPONSE');
          return known;
        }
        await store.checkpoint(intent, owner, 'planned', { rowRecipe: rows });
        return rows;
      },
      async rememberSheetRows(rows) {
        if (intent.checkpoint.sheetRows !== undefined) {
          if (!Array.isArray(intent.checkpoint.sheetRows))
            throw new TeamFunctionError('INVALID_RESPONSE');
          const known: XlsxCell[][] = [];
          for (const row of intent.checkpoint.sheetRows) {
            if (!Array.isArray(row)) throw new TeamFunctionError('INVALID_RESPONSE');
            const cells: XlsxCell[] = [];
            for (const c of row) {
              if (!isRecord(c)) throw new TeamFunctionError('INVALID_RESPONSE');
              if (c.t === 'number' && typeof c.v === 'number') cells.push({ t: 'number', v: c.v });
              else if ((c.t === 'string' || c.t === 'decimal') && typeof c.v === 'string')
                cells.push({ t: c.t, v: c.v });
              else throw new TeamFunctionError('INVALID_RESPONSE');
            }
            known.push(cells);
          }
          return known;
        }
        await store.checkpoint(intent, owner, 'planned', { sheetRows: rows });
        return rows;
      },
      async proveVideo(video, drive) {
        const live = await deps.proveVideo(video, drive);
        const key = `source_${video.id}`;
        const identity = {
          id: live.id,
          version: live.version,
          checksum: live.checksum,
          modifiedAt: live.modifiedAt,
          resourceKey: live.resourceKey
        };
        const known = intent.checkpoint[key];
        if (
          known !== undefined &&
          (!isRecord(known) ||
            known.id !== identity.id ||
            // Drive permission changes may advance version without changing binary content.
            // A proven MD5 is stronger than version; unknown checksums retain strict checks.
            (typeof known.checksum === 'string' &&
            /^[a-f0-9]{32}$/iu.test(known.checksum) &&
            typeof identity.checksum === 'string' &&
            /^[a-f0-9]{32}$/iu.test(identity.checksum)
              ? known.checksum.toLowerCase() !== identity.checksum.toLowerCase()
              : known.version !== identity.version ||
                known.checksum !== identity.checksum ||
                known.modifiedAt !== identity.modifiedAt) ||
            known.resourceKey !== identity.resourceKey ||
            (identity.version === null && identity.checksum === null))
        )
          throw new TeamFunctionError('SOURCE_CHANGED');
        if (known === undefined)
          await store.checkpoint(intent, owner, intent.state, { [key]: identity });
        return live;
      },
      async nextVariant() {
        return intent.variant;
      },
      async drawTexts(team, count) {
        await ensureResources();
        if (Array.isArray(intent.checkpoint.texts)) {
          const values = [];
          for (const row of intent.checkpoint.texts) {
            if (
              !isRecord(row) ||
              typeof row.title !== 'string' ||
              typeof row.description !== 'string'
            )
              throw new TeamFunctionError('INVALID_RESPONSE');
            values.push({ title: row.title, description: row.description });
          }
          return values;
        }
        await check();
        const texts = await deps.drawTexts(team, count);
        await store.checkpoint(intent, owner, 'planning', { texts });
        return texts;
      },
      async drawImages(team, count) {
        await ensureResources();
        if (Array.isArray(intent.checkpoint.images)) {
          const values = [];
          for (const row of intent.checkpoint.images) {
            if (
              !isRecord(row) ||
              typeof row.driveFileId !== 'string' ||
              (row.resourceKey !== null && typeof row.resourceKey !== 'string') ||
              (row.name !== null && row.name !== undefined && typeof row.name !== 'string')
            )
              throw new TeamFunctionError('INVALID_RESPONSE');
            values.push({
              driveFileId: row.driveFileId,
              resourceKey: row.resourceKey,
              name: row.name
            });
          }
          return values;
        }
        await check();
        const images = await deps.drawImages(team, count);
        await store.checkpoint(intent, owner, 'planning', { images });
        return images;
      },
      async planName(input) {
        if (
          isRecord(intent.checkpoint.namePlan) &&
          typeof intent.checkpoint.namePlan.name === 'string' &&
          typeof intent.checkpoint.namePlan.reservationKey === 'string'
        )
          return {
            name: intent.checkpoint.namePlan.name,
            reservationKey: intent.checkpoint.namePlan.reservationKey
          };
        await check();
        const plan = await deps.planName(input);
        await store.checkpoint(intent, owner, 'planned', { namePlan: plan });
        return plan;
      },
      async startOperation(input) {
        await check();
        const operation = await deps.startOperation({
          ...input,
          idempotencyKey: `catalog:${intent.id}:${intent.attempt}`
        });
        if (operation.state === 'canceled' || operation.state === 'failed')
          throw new TeamFunctionError('WRONG_STATE');
        await store.checkpoint(intent, owner, intent.state, {}, operation.operationId);
        return { ...operation, reused: false };
      },
      async markRunning(id) {
        await check();
        if (child?.state !== 'succeeded') await deps.markRunning(id);
      },
      async driveFor(credentialId) {
        const drive = await fullDriveFor(credentialId);
        return {
          getFile: drive.getFile.bind(drive),
          async listAnyonePermissions(fileId) {
            const permissions = await drive.listAnyonePermissions(fileId);
            if (permissions.length)
              await store.permission(
                intent,
                owner,
                fileId,
                credentialId,
                permissions[0].id,
                'preserved'
              );
            return permissions;
          },
          async createAnyoneReaderPermission(fileId) {
            await check();
            await store.permission(intent, owner, fileId, credentialId, null, 'pending');
            const permission = await drive.createAnyoneReaderPermission(fileId);
            await store.permission(intent, owner, fileId, credentialId, permission.id, 'created');
            return permission;
          },
          async createConvertedFile(input) {
            await check();
            let file: DriveFileMetadata;
            const recovered = await recoverFile(input.parentId, credentialId);
            if (recovered) return recovered;
            await store.checkpoint(intent, owner, 'create_started', {
              createStarted: true,
              parentId: input.parentId,
              credentialId
            });
            try {
              file = await drive.createConvertedFile({
                ...input,
                appProperties: { ...input.appProperties, 'soty.catalog.intent': intent.id }
              });
            } catch (error) {
              if (
                error instanceof TeamFunctionError &&
                ['NEEDS_REAUTH', 'PERMISSION_DENIED', 'RATE_LIMITED'].includes(error.code)
              )
                await store.checkpoint(intent, owner, 'planned', {
                  createStarted: false,
                  createRefusedCode: error.code
                });
              throw error;
            }
            if (
              file.trashed ||
              file.mimeType !== 'application/vnd.google-apps.spreadsheet' ||
              !file.parents.includes(input.parentId) ||
              file.appProperties['soty.catalog.intent'] !== intent.id
            )
              throw new TeamFunctionError('LAUNCH_RESULT_UNCERTAIN');
            await store.checkpoint(intent, owner, 'created', { providerFileId: file.id });
            return file;
          },
          async updateFileMetadata(input) {
            await check();
            return drive.updateFileMetadata(input);
          }
        };
      },
      async bindIntent(input) {
        await check();
        if (child?.state !== 'succeeded') await deps.bindIntent(input);
      },
      async finalize(input) {
        await check();
        const result =
          child?.state === 'succeeded' && child.materialId
            ? { materialId: child.materialId }
            : await deps.finalize(input);
        await store.checkpoint(intent, owner, 'finalized', { materialId: result.materialId });
        return result;
      },
      async link(input) {
        await check();
        const linked = await deps.link(input);
        if (linked.linked)
          await store.checkpoint(intent, owner, intent.state, { linkCompleted: true });
        return linked;
      }
    };
    const result = await createProductCatalog(wrapped, request, actor);
    await store.checkpoint(intent, owner, 'registered', {}, undefined, result);
    return result;
  } catch (error) {
    await store.checkpoint(intent, owner, 'interrupted', {}).catch(() => undefined);
    throw launchFailure(error);
  }
}
