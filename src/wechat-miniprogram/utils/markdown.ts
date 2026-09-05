// 轻量 GFM→HTML 转换器（小程序用，配合 mp-html 组件渲染）。
//
// 安全：先对整个源做 HTML-escape，原始 HTML 一律当文本显示（与 Web 端
// react-markdown 从不启用 rehypeRaw 的「原始 HTML inert」行为一致），
// 模型输出里的 <script> / onerror 等不会成为标记。
//
// 支持子集：段落 / 标题 / 加粗 / 斜体 / 行内 code / 围栏代码块 / 无序·有序列表 /
// 引用 / 分割线 / 链接 / GFM 表格。原始 HTML 一律 inert。

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

// GFM 表格。仅当 `| a | b |`（含 `|`）的下一个非空行是 `| --- |` 分隔行时才判定
// 为表格；身体行吸收后续含 `|` 的连续行。单元格内容经 escape+inline 渲染，避免注入。
function parseTable(lines: string[], i: number): { html: string; next: number } | null {
  const header = lines[i].trim();
  const delim = (lines[i + 1] || '').trim();
  if (!header.startsWith('|') || !delim.startsWith('|')) return null;

  const stripCells = (s: string): string[] =>
    s.replace(/^\|/, '').replace(/\|$/, '').split('|');
  const delimCells = stripCells(delim).map((s) => s.trim());
  if (!delimCells.length || !delimCells.every((c) => /^:?-+:?$/.test(c))) return null;

  const aligns = delimCells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    return left && right ? 'center' : left ? 'left' : right ? 'right' : '';
  });

  const renderRow = (raw: string, tag: 'th' | 'td'): string =>
    `<tr>${stripCells(raw)
      .map((s, idx) => {
        const a = aligns[idx] || '';
        const style = a ? ` style="text-align:${a};"` : '';
        return `<${tag}${style}>${inline(escapeHtml(s.trim()))}</${tag}>`;
      })
      .join('')}</tr>`;

  const body: string[] = [];
  let j = i + 2;
  while (j < lines.length) {
    const t = lines[j].trim();
    if (!t || !t.includes('|')) break;
    body.push(renderRow(lines[j], 'td'));
    j += 1;
  }

  return {
    html: `<table><thead>${renderRow(header, 'th')}</thead><tbody>${body.join('')}</tbody></table>`,
    next: j,
  };
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

    // GFM 表格
    if (t.startsWith('|')) {
      const tbl = parseTable(lines, i);
      if (tbl) {
        out.push(tbl.html);
        i = tbl.next;
        continue;
      }
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
    ['| a | b |\n| --- | --- |\n| 1 | 2 |', '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'],
    ['| k | v |\n| :- | -: |\n| x | y |', '<table><thead><tr><th style="text-align:left;">k</th><th style="text-align:right;">v</th></tr></thead><tbody><tr><td style="text-align:left;">x</td><td style="text-align:right;">y</td></tr></tbody></table>'],
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
