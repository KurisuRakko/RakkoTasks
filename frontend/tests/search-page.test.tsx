// SearchPage 测试：输入问题 → 点「搜索」→ mock POST /api/search → 渲染 AI 回答与引用列表。
// haze 底衬覆盖：AI 回答整块一团雾（上游 .glass-review__note 档：max-width 72ch +
// bleed 0.4 × token），「引用邮件（N）」标题一团雾（上游 .glass-review__label 档：
// width: max-content + bleed 0.3 × token）；cloud 默认形态不带 data-haze；markdown
// 段落不各自挂雾（[data-glass="haze"] 全页恰好 2 个）；引用行仍是 data-glass="panel"
// 且数量 = citations 数；任何 data-glass 元素都不嵌套在另一块 data-glass 里（回答块
// 与引用列表实测是兄弟关系）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SearchPage from '../src/pages/SearchPage';
import searchSource from '../src/pages/SearchPage.tsx?raw';
import type { SearchCitation, SearchResponse } from '../src/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 每个 question 生成独有回答文本。SearchPage 的 lastResultCache 是模块级缓存，
 *  测试里无法重置、跨用例残留——用例靠「本次 question 独有的段落」确认自己那次
 *  搜索的结果已上屏，而不是读到上一个用例的残留。 */
function makeResult(question: string, citations: SearchCitation[]): SearchResponse {
  return {
    answer_md: `## 关于「${question}」\n\n${question} 的第一段正文。\n\n这是第二段正文，补充更多细节。`,
    citations,
  };
}

const CITATIONS: SearchCitation[] = [
  { email_id: 11, subject: '引用邮件主题一', sent_at: '2026-08-01T00:00:00Z' },
  { email_id: 12, subject: '引用邮件主题二', sent_at: null },
  { email_id: 13, subject: '引用邮件主题三', sent_at: '2026-08-03T09:30:00Z' },
];

/** POST /api/search 返回固定结果，其余请求一律 404 */
function makeFetchMock(result: SearchResponse) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === '/api/search' && init?.method === 'POST') return json(result);
    return json({}, 404);
  });
}

/** 渲染 SearchPage → 输入 question → 点「搜索」→ 等本次回答独有的段落上屏 */
async function renderAndSearch(fetchMock: ReturnType<typeof makeFetchMock>, question: string) {
  vi.stubGlobal('fetch', fetchMock);
  const utils = render(<SearchPage />);
  const textarea = await screen.findByPlaceholderText(/问你的邮件库/);
  fireEvent.change(textarea, { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  await screen.findByText(`${question} 的第一段正文。`);
  return utils;
}

// 从 ?raw 源码取出第 occurrence（0 起）个 data-glass="haze" 所在开标签的整段文本。
// jsdom 对 emotion 编译出的类给不出可靠的 computed 样式值，宽度/bleed 这类写法断言
// 一律落回源码原文，否则会写出永远为真的假断言（与 tasks-page.test.tsx 同一约定）。
function hazeHostTag(source: string, occurrence: number): string {
  let idx = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    idx = source.indexOf('data-glass="haze"', idx + 1);
    expect(idx).toBeGreaterThan(-1);
  }
  const start = source.lastIndexOf('<', idx);
  const end = source.indexOf('>', idx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(-1);
  return source.slice(start, end + 1);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SearchPage haze 底衬（AI 回答 note 档 + 引用标题 label 档）', () => {
  it('出结果后全页恰好两个 [data-glass="haze"]（回答块 + 引用标题），且都不带 data-haze', async () => {
    const question = '截止日期问题';
    const fetchMock = makeFetchMock(makeResult(question, CITATIONS));
    const { container } = await renderAndSearch(fetchMock, question);

    const hazes = container.querySelectorAll('[data-glass="haze"]');
    expect(hazes).toHaveLength(2);
    // cloud 是上游配方的默认形态，默认不写 data-haze——只有切 veil 才写该属性
    for (const haze of Array.from(hazes)) {
      expect(haze.hasAttribute('data-haze')).toBe(false);
    }
  });

  it('AI 回答整块挂雾：包住全部 markdown 段落，段落自身没有 data-glass，雾里再无别的玻璃', async () => {
    const question = '整块雾问题';
    const fetchMock = makeFetchMock(makeResult(question, CITATIONS));
    const { container } = await renderAndSearch(fetchMock, question);

    const markerP = screen.getByText(`${question} 的第一段正文。`);
    expect(markerP.tagName).toBe('P');

    const answerHaze = markerP.closest('[data-glass="haze"]') as HTMLElement | null;
    expect(answerHaze).not.toBeNull();
    expect(answerHaze!.tagName).toBe('DIV'); // 宿主是 Box
    expect(answerHaze!.getAttribute('data-glass')).toBe('haze');

    // 块内 markdown 段落全被这一团雾包着（雾 = 整块一团），段落本身不带 data-glass
    const paragraphs = Array.from(answerHaze!.querySelectorAll('p'));
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const p of paragraphs) {
      expect(p.hasAttribute('data-glass')).toBe(false);
      expect(p.closest('[data-glass]')).toBe(answerHaze);
    }

    // 雾元素内部不允许再出现任何 data-glass：既没有逐段加雾，也没有嵌套玻璃
    expect(answerHaze!.querySelectorAll('[data-glass]')).toHaveLength(0);

    // 全页只剩引用标题那一团雾（顺带锁定雾总数，防止未来有人给段落各自挂雾）
    expect(container.querySelectorAll('[data-glass="haze"]')).toHaveLength(2);
  });

  it('「引用邮件（N）」标题是 data-glass="haze" 的块级 h6：subtitle2 默认渲染成 h6，width 才生效', async () => {
    const question = '标题形态问题';
    const fetchMock = makeFetchMock(makeResult(question, CITATIONS));
    await renderAndSearch(fetchMock, question);

    // MUI Typography 的 variantMapping 把 subtitle2 映射成 h6（对照 node_modules 内
    // Typography.js 的默认映射，实测渲染出的 tagName 就是 H6）。h6 是 HTML 块级元素
    // （浏览器 UA 样式 display: block），width: max-content 只有在块级盒上才会收缩
    // 贴合文字——jsdom 给不出可靠的 computed display，这里断言实际渲染出的元素类型。
    const title = screen.getByText(`引用邮件（${CITATIONS.length}）`);
    expect(title.tagName).toBe('H6');
    expect(title.getAttribute('data-glass')).toBe('haze');
    expect(title.hasAttribute('data-haze')).toBe(false);
  });

  it('引用列表行仍带 data-glass="panel"（数量 = citations 数），与回答雾是兄弟、无嵌套玻璃', async () => {
    const question = '引用列表问题';
    const fetchMock = makeFetchMock(makeResult(question, CITATIONS));
    const { container } = await renderAndSearch(fetchMock, question);

    // 引用行保持 data-glass="panel"，一行一块玻璃，数量与 citations 一一对应
    const panels = container.querySelectorAll('[data-glass="panel"]');
    expect(panels).toHaveLength(CITATIONS.length);
    for (const panel of Array.from(panels)) {
      expect(panel.classList.contains('MuiListItemButton-root')).toBe(true);
    }

    // 嵌套实测：引用列表不能落在回答雾内部——两团雾是同一容器的直接子级（兄弟），
    // 该容器自身不带 data-glass。若谁把引用列表挪进回答块，这里先翻。
    const markerP = screen.getByText(`${question} 的第一段正文。`);
    const answerHaze = markerP.closest('[data-glass="haze"]') as HTMLElement | null;
    const title = screen.getByText(`引用邮件（${CITATIONS.length}）`);
    expect(answerHaze).not.toBeNull();
    expect(answerHaze!.parentElement).toBe(title.parentElement);
    expect(answerHaze!.parentElement!.hasAttribute('data-glass')).toBe(false);

    // 全页任何 [data-glass] 元素都不能是另一块 [data-glass] 的后代（禁止嵌套玻璃）
    for (const glass of Array.from(container.querySelectorAll('[data-glass]'))) {
      expect(glass.parentElement!.closest('[data-glass]')).toBeNull();
    }
  });

  it('无引用（citations 为空）时不渲染「引用邮件」标题，只剩回答那一团雾', async () => {
    const question = '没有引用的提问';
    const fetchMock = makeFetchMock(makeResult(question, []));
    const { container } = await renderAndSearch(fetchMock, question);

    expect(container.querySelectorAll('[data-glass="haze"]')).toHaveLength(1);
    expect(screen.queryByText('引用邮件（0）')).toBeNull();
  });

  it('回答雾源码（note 档）：max-width 72ch + bleed calc(0.4 × GLASS.hazeBleed)，cloud 无 data-haze、无写死 px', () => {
    // 第一处 data-glass="haze" 是回答块（在文件里先于引用标题出现）
    const noteTag = hazeHostTag(searchSource, 0);
    expect(noteTag).toContain('data-glass="haze"');
    expect(noteTag).toContain('typography');
    // note 档限宽用 max-width: 72ch 而不是 width: max-content（多行文本要占满可读行宽）
    expect(noteTag).toContain("maxWidth: '72ch'");
    expect(noteTag).not.toContain('max-content');
    // bleed 引用 token 的 0.4 倍，不许写死数值
    expect(noteTag).toContain('calc(0.4 * ${GLASS.hazeBleed})');
    expect(noteTag).not.toContain('calc(0.3 *');
    // cloud 默认形态：宿主开标签里没有 data-haze 属性
    expect(noteTag).not.toContain('data-haze=');
    expect(noteTag).not.toMatch(/--glass-haze-bleed[^,]*?\dpx/);
  });

  it('引用标题源码（label 档）：width max-content + bleed calc(0.3 × GLASS.hazeBleed)，cloud 无 data-haze、无写死 px', () => {
    // 第二处 data-glass="haze" 是引用标题（同 TasksPage 分组标题的 label 档写法）
    const labelTag = hazeHostTag(searchSource, 1);
    expect(labelTag).toContain('data-glass="haze"');
    expect(labelTag).toContain('variant="subtitle2"');
    expect(labelTag).toContain("width: 'max-content'");
    expect(labelTag).toContain('calc(0.3 * ${GLASS.hazeBleed})');
    expect(labelTag).not.toContain('calc(0.4 *');
    // cloud 默认形态：宿主开标签里没有 data-haze 属性
    expect(labelTag).not.toContain('data-haze=');
    expect(labelTag).not.toMatch(/--glass-haze-bleed[^,]*?\dpx/);
  });
});
