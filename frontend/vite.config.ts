import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// 版本号注入：构建时把 package.json 的 version 定义为 __APP_VERSION__（对 vitest 同样生效）

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // iOS 常驻 PWA 不会自行复查 SW、也不会自动重载页面，autoUpdate 形同虚设：
      // 改为 prompt，何时激活并重载由 src/lib/pwa-update.ts 主动决定（行为可测）
      registerType: 'prompt',
      // 不注入自动注册脚本，注册/周期检查/回前台补查统一走 src/lib/pwa-update.ts
      injectRegister: false,
      // 默认壁纸必须进预缓存：它是背景层的图源，离线时命中不到就是空背景。workbox 的
      // globPatterns 默认只收 js/wasm/css/html，jpg 收不进来，所以随 includeAssets 单列
      // （该列表按 public 目录解析，与 icon.svg 同一机制）。
      // 0.9MB 在 workbox 的 maximumFileSizeToCacheInBytes 默认 2MB 之内，不必调上限。
      includeAssets: ['icon.svg', 'wallpaper-default.jpg'],
      manifest: {
        name: 'RakkoTasks',
        short_name: 'RakkoTasks',
        lang: 'zh-CN',
        display: 'standalone',
        start_url: '/',
        theme_color: '#f9f8f5',
        background_color: '#f9f8f5',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        // API / CalDAV / .well-known 路径不能被 SPA 导航兜底缓存
        navigateFallbackDenylist: [/^\/api\//, /^\/caldav/, /^\/\.well-known\//],
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    css: false,
  },
});
