import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { setupPwaUpdate } from './lib/pwa-update';
// 玻璃材质样式表：全项目唯一带 backdrop-filter 的样式表，必须在应用入口无条件加载，
// 材质要从首帧就在（它的 --glass-* 变量由 theme.ts 经 CssBaseline 下发到 :root）。
import './rakko-glass.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA 新版本检查：iOS 主屏 App 常驻后不会自行复查 Service Worker，必须在应用
// 启动后主动周期检查（回到前台时补查），发现新版直接重载（见 lib/pwa-update.ts）。
setupPwaUpdate();
