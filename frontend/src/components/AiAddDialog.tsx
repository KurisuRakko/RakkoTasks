// AiAddDialog：AI 快速添加任务的全屏对话框（移动端全屏、桌面端限宽），由右下角
// 悬浮按钮经 expand-fab 容器变换长出。与 ItemEditor 的分工：ItemEditor 是「手填
// 四个字段」，这里是「说一句话让 AI 填」，两者共用 ItemFieldsForm 渲染字段区。
//
// 三个阶段（用 Collapse/Fade 过渡，不新增 VtKind——那会连带改 motion-styles 的
// 转场契约与其断言；FAB 长出对话框那段容器变换沿用现成的 expand-fab）：
//   input   → 只有一个多行输入框，自动聚焦让 iOS 键盘弹起
//   parsing → 骨架卡（非速记模式等待 LLM 的 1-3 秒）
//   fields  → ItemFieldsForm，值由解析结果预填，用户可改后保存
//
// 速记模式（AppBar 右上角 Switch）打开时跳过 parsing/fields：点「确定」直接把原文
// 交给 onQuickSubmit，由调用方立刻关窗并在后台落库。
//
// ⚠ 本文件当前是契约基座的占位实现，只钉死 Props 形状供编排层（TasksPage）并行
// 开发；真实渲染由 B 路补齐。

import type { ItemFields, ParsedTask } from '../types';

export interface AiAddDialogProps {
  /** 速记模式当前值。受控：状态与持久化（localStorage）都在 TasksPage */
  quickMode: boolean;
  /** 用户拨动速记开关 */
  onQuickModeChange: (next: boolean) => void;
  /**
   * 非速记模式的解析入口：一句话 → 结构化字段。由调用方注入而非本组件直接调
   * api.ts，测试才能不打 fetch 就驱动三个阶段。
   * reject 时组件停在 input 阶段并给出错误提示与「按原文添加」兜底。
   */
  onParse: (text: string) => Promise<ParsedTask>;
  /** 阶段二「保存」：与 ItemEditor.onSubmit 同语义，走 POST /api/items */
  onSubmit: (fields: ItemFields) => void;
  /**
   * 速记模式「确定」：只把原文交出去。关窗与后台落库（POST /api/items/quick）
   * 都由调用方负责——窗口要立刻关，落库不能绑在本组件的生命周期上。
   */
  onQuickSubmit: (text: string) => void;
  /** 阶段二保存中：禁用保存按钮 */
  submitting: boolean;
  onClose: () => void;
  /** 容器变换共享名：传给 Dialog paper；缺省则 paper 不持名 */
  viewTransitionName?: string;
}

export default function AiAddDialog(_props: AiAddDialogProps) {
  return null;
}
