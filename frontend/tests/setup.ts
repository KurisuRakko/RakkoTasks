// vitest 全局 setup：注册 jest-dom 匹配器。
import '@testing-library/jest-dom/vitest';

// Node ≥22 在 globalThis 上挂了实验性 localStorage（未启用时访问值为 undefined）。
// vitest populateGlobal 以 `key in global` 过滤 window 属性时被它抢占，jsdom 的
// localStorage 因此不会挂到 globalThis；又因 `global.window = global`，测试里的
// window 也不是 jsdom 真身（真身在 global.jsdom.window）。这里显式把 jsdom 的
// storage 挂到 globalThis，测试内即可正常读写（vitest 3.x/4.x + Node 26 复现）。
const jsdomWindow = (globalThis as { jsdom?: { window: Window & typeof globalThis } }).jsdom
  ?.window;
if (jsdomWindow) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: jsdomWindow.localStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: jsdomWindow.sessionStorage,
    configurable: true,
    writable: true,
  });
}
