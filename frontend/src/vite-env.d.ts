/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基地址，默认空串（同源） */
  readonly VITE_API_BASE_URL?: string;
  /** Phainon 认证服务基地址 */
  readonly VITE_PHAINON_API_BASE?: string;
  /** Phainon 应用 ID */
  readonly VITE_PHAINON_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** 构建时注入的 package.json version（vite.config.ts define） */
declare const __APP_VERSION__: string;
