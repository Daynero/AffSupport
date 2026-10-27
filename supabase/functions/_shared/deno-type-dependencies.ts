// The local Supabase CLI mounts external modules from runtime imports only.
// Deno also resolves @deno-types/@ts-self-types while constructing its graph.
// Keep these generated declaration modules in both graphs; they emit no code.
import '../../../packages/shared/dist/team/contract.d.ts';
import '../../../packages/shared/dist/team/transport.d.ts';
import '../../../packages/shared/dist/team/material-category.d.ts';
import '../../../packages/shared/dist/team/catalog-images.d.ts';
