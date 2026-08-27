// 环境变量统一出口：所有 import.meta.env.VITE_* 都在这里给默认值。
// 未定义时 vite 注入的值是 undefined，`??` 即可兜底（空字符串会原样保留）。

/** 后端 API 基地址；默认空串 = 同源（生产由 FastAPI 托管 SPA） */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

/** Phainon 认证服务基地址 */
export const PHAINON_API_BASE = import.meta.env.VITE_PHAINON_API_BASE ?? 'https://api.rakko.cn';

/** Phainon 应用 ID */
export const PHAINON_APP_ID = import.meta.env.VITE_PHAINON_APP_ID ?? 'rakkotasks';
