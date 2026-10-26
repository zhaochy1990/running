/**
 * SafeMarkdown — react-markdown 的安全封装（链接白名单 + 表格横滚）。
 *
 * 口径与约束：react-markdown + remark-gfm，永不启用 rehypeRaw（正文里的
 * 原始 HTML 惰性化）；链接仅放行 http(s)/mailto/相对路径（javascript:
 * 等危险 scheme 的链接渲染为不可点击文本），外链补 noopener。
 *
 * 使用方：CoachChatMessage（教练气泡）/ DeclarationPage（公开声明页）。
 * 新增 markdown 渲染点一律复用本组件，不要各自内联一份链接消毒逻辑。
 */
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Only http(s) and mailto links are allowed to render as clickable anchors. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  // Relative links are allowed; anything with a disallowed scheme is dropped.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  return trimmed;
}

function MarkdownLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  const safe = safeHref(href);
  if (!safe) {
    // Render the link text without an href so it is not clickable.
    return <span {...rest}>{children}</span>;
  }
  const external = /^https?:/i.test(safe);
  return (
    <a href={safe} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...rest}>
      {children}
    </a>
  );
}

function MarkdownTable({ children, ...rest }: ComponentPropsWithoutRef<"table">) {
  // Wrap tables so wide content scrolls horizontally instead of overflowing.
  return (
    <div className="overflow-x-auto">
      <table {...rest}>{children}</table>
    </div>
  );
}

const markdownComponents = {
  a: MarkdownLink,
  table: MarkdownTable,
};

export default function SafeMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}
