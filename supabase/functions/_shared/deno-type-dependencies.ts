// The local Supabase CLI mounts external modules from runtime imports only.
// Deno also resolves @deno-types/@ts-self-types while constructing its graph.
// Keep these generated declaration modules in both graphs; they emit no code.
import '../../../packages/shared/dist/team/contract.d.ts';
import '../../../packages/shared/dist/team/transport.d.ts';
import '../../../packages/shared/dist/team/material-category.d.ts';
import '../../../packages/shared/dist/team/catalog-images.d.ts';

import '../../../packages/shared/dist/team/catalog-video-foreground.d.ts';
import '../../../packages/shared/dist/team/catalog-video-r2.d.ts';
import '../../../packages/shared/dist/team/catalog-publication-source.d.ts';
import '../../../packages/shared/dist/team/catalog-global-images.d.ts';
import '../../../packages/shared/dist/team/catalog-global-alias.d.ts';
import '../../../packages/shared/dist/team/transcript-translation.d.ts';
// 064: the launch assistant and credits.
import '../../../packages/shared/dist/team/ai-credits.d.ts';
import '../../../packages/shared/dist/team/assistant.d.ts';
import '../../../packages/shared/dist/team/assistant-apply.d.ts';
import '../../../packages/shared/dist/team/launches/defaults-merge.d.ts';
import '../../../packages/shared/dist/team/launches/fields.d.ts';
import '../../../packages/shared/dist/team/launches/naming.d.ts';
// 064: the assistant's money tools read the Accounts report.
import '../../../packages/shared/dist/team/agent-finance.d.ts';
import '../../../packages/shared/dist/team/agent-finance-report.d.ts';
// 073: the catalog image optimizer and the R2 worker strip metadata on the way out.
import '../../../packages/shared/dist/media-metadata.d.ts';
// 057: the space bucket client, the read grant and the storage journal.
import '../../../packages/shared/dist/team/space-storage.d.ts';
import '../../../packages/shared/dist/team/space-storage-md5.d.ts';
import '../../../packages/shared/dist/team/space-read-grant.d.ts';
