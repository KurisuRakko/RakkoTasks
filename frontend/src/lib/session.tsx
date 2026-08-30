// 会话上下文：AuthGate 从 getMe() 拿到的用户信息，经此提供给页面（设置页显示登录者）。

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { PhainonMe } from '../types';

export const SessionContext = createContext<PhainonMe | null>(null);

export function SessionProvider({ value, children }: { value: PhainonMe | null; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** 当前登录者；未登录（AuthGate 未就绪）时为 null */
export function useSession(): PhainonMe | null {
  return useContext(SessionContext);
}
