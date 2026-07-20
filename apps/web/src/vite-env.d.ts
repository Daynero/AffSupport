/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SITE_URL?: string;
  readonly VITE_ADMIN_EMAIL?: string;
  readonly VITE_PRODUCT_OPERATOR?: string;
  readonly VITE_LEGAL_CONTACT_EMAIL?: string;
  readonly VITE_AGENT_URL?: string;
  readonly VITE_ANALYTICS_ENABLED?: string;
  readonly VITE_LOCAL_DEV_AUTH?: string;
  readonly VITE_WEB_REVISION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
