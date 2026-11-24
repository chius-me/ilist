/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REPO_URL?: string;
  readonly VITE_CONTACT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
