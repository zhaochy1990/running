// 轻量 GFM→HTML 转换器（小程序用，配合 mp-html 组件渲染）。
//
// 安全：先对整个源做 HTML-escape，原始 HTML 一律当文本显示（与 Web 端
// react-markdown 从不启用 rehypeRaw 的「原始 HTML inert」行为一致），
// 模型输出里的 <script> / onerror 等不会成为标记。
//
// 支持子集：段落 / 标题 / 加粗 / 斜体 / 行内 code / 围栏代码块 / 无序·有序列表 /
// 引用 / 分割线 / 链接。默认不解析 GFM 表格（coach 回复罕见；
// 需要时各端统一换 marked.js 再补）。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 作用于已 escape 的文本，只转行内标记。
function inline(s: string): string {
  let r = s;
  r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
  r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  r = r.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  r = r.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return r;
}

function isBlockStart(line: string): boolean {
  const t = line.trim();
  return (
    t === '' ||
    /^```/.test(t) ||
    /^(#{1,6})\s+/.test(t) ||
    /^[-*+]\s+/.test(t) ||
    /^\d+\.\s+/.test(t) ||
    /^>\s?/.test(t)
  );
}

export function markdownToHtml(src: string): string {
  if (!src) return '';
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    if (t === '') {
      i += 1;
      continue;
    }

    // 围栏代码块
    if (/^```/.test(t)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out.push('<hr/>');
      i += 1;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      out.push(`<h${h[1].length}>${inline(escapeHtml(h[2]))}</h${h[1].length}>`);
      i += 1;
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^[-*+]\s+(.*)$/.exec(lines[i].trim());
        if (!m) break;
        items.push(`<li>${inline(escapeHtml(m[1]))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\d+\.\s+(.*)$/.exec(lines[i].trim());
        if (!m) break;
        items.push(`<li>${inline(escapeHtml(m[1]))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // 引用（按行拆成独立 blockquote）
    if (/^>\s?/.test(t)) {
      out.push(`<blockquote>${inline(escapeHtml(t.replace(/^>\s?/, '')))}</blockquote>`);
      i += 1;
      continue;
    }

    // 段落：吸收连续非块起始行，行内换行用 <br/>
    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${para.map((p) => inline(escapeHtml(p))).join('<br/>')}</p>`);
  }

  return out.join('') || escapeHtml(src);
}

// 自检：小程序可在 devtools 控制台调 `demoMarkdown()` 断言通过。
export function demoMarkdown(): void {
  const cases: Array<[string, string]> = [
    ['**加粗**', '<p><strong>加粗</strong></p>'],
    ['# 标题', '<h1>标题</h1>'],
    ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
    ['1. x\n2. y', '<ol><li>x</li><li>y</li></ol>'],
    ['`code`', '<p><code>code</code></p>'],
    ['<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
    ['第一行\n**加粗**\n\n# H2', '<p>第一行<br/><strong>加粗</strong></p><h1>H2</h1>'],
  ];
  for (const [input, expected] of cases) {
    const got = markdownToHtml(input);
    if (got !== expected) {
      throw new Error(`markdownToHtml(${JSON.stringify(input)}) => ${got}, want ${expected}`);
    }
  }
  // 原始 HTML 必须 inert
  if (markdownToHtml('<b>x</b>') !== '<p>&lt;b&gt;x&lt;/b&gt;</p>') {
    throw new Error('raw HTML not escaped');
  }
}
