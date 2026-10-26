import SwiftUI

/// 简易 GFM markdown 渲染（PR-2 登录域）：declaration 正文用。
///
/// mapping.md 转译约定：mp-html → `AttributedString(markdown:)` 或简易
/// 渲染器（先确认内容是 markdown 而非任意 HTML——声明端点给的是
/// `content_markdown`，故无需 WKWebView）。覆盖声明文档实际用到的块：
/// 标题 / 段落 / 有序无序列表 / 引用 / 分隔线 / 表格 / 围栏代码块；
/// 行内样式（粗体、斜体、代码、链接）交给 `AttributedString` 的
/// inline-only 解析。
public struct MarkdownText: View {

    private let markdown: String
    private let theme: any Theme

    public init(_ markdown: String, theme: any Theme) {
        self.markdown = markdown
        self.theme = theme
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
    }

    // MARK: - 块模型

    enum Block: Equatable {
        case heading(level: Int, text: String)
        case paragraph(String)
        case bulletList(items: [String])
        case numberedList(items: [String])
        case quote(String)
        case divider
        case table(header: [String], rows: [[String]])
        case code(lines: [String])
    }

    /// 块解析（纯函数，只读存储属性）。nonisolated：View 结构体的
    /// @MainActor 推断不适用于解析逻辑，测试可在任意执行器直取。
    nonisolated var blocks: [Block] {
        var result: [Block] = []
        var paragraphLines: [String] = []
        var bullets: [String] = []
        var numbers: [String] = []
        var tableRows: [[String]] = []
        var inCode = false
        var codeLines: [String] = []

        func flushParagraph() {
            if !paragraphLines.isEmpty {
                result.append(.paragraph(paragraphLines.joined(separator: "\n")))
                paragraphLines = []
            }
        }

        func flushLists() {
            if !bullets.isEmpty {
                result.append(.bulletList(items: bullets))
                bullets = []
            }
            if !numbers.isEmpty {
                result.append(.numberedList(items: numbers))
                numbers = []
            }
        }

        func flushTable() {
            // GFM 表格：第二行是 |---|---| 对齐行，跳过；首行为表头。
            if tableRows.count >= 2 {
                result.append(.table(header: tableRows[0], rows: Array(tableRows.dropFirst())))
            } else if tableRows.count == 1 {
                result.append(.paragraph(tableRows[0].joined(separator: " ")))
            }
            tableRows = []
        }

        for rawLine in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine).trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if inCode {
                    result.append(.code(lines: codeLines))
                    codeLines = []
                } else {
                    flushParagraph(); flushLists(); flushTable()
                }
                inCode.toggle()
                continue
            }
            if inCode {
                codeLines.append(String(rawLine))
                continue
            }

            // 表格行（含 | 且非段落续行）
            if line.contains("|"), line.split(separator: "|").count >= 2 {
                let cells = line
                    .trimmingCharacters(in: CharacterSet(charactersIn: "|"))
                    .split(separator: "|")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                if cells.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0 == "-" || $0 == ":" }) }) {
                    continue // 对齐行
                }
                flushParagraph(); flushLists()
                tableRows.append(cells)
                continue
            }
            flushTable()

            if line.isEmpty {
                flushParagraph(); flushLists()
            } else if line.hasPrefix("####") {
                flushParagraph(); flushLists()
                result.append(.heading(level: 4, text: String(line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces))))
            } else if line.hasPrefix("###") {
                flushParagraph(); flushLists()
                result.append(.heading(level: 3, text: String(line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces))))
            } else if line.hasPrefix("##") {
                flushParagraph(); flushLists()
                result.append(.heading(level: 2, text: String(line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces))))
            } else if line.hasPrefix("#") {
                flushParagraph(); flushLists()
                result.append(.heading(level: 1, text: String(line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces))))
            } else if line == "---" || line == "***" {
                flushParagraph(); flushLists()
                result.append(.divider)
            } else if line.hasPrefix("> ") {
                flushParagraph(); flushLists()
                result.append(.quote(String(line.dropFirst(2))))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flushParagraph()
                if numbers.isEmpty == false { flushLists() }
                bullets.append(String(line.dropFirst(2)))
            } else if line.first.map(\.isNumber) == true, let space = line.firstIndex(where: { $0 == " " || $0 == "." }),
                      line[line.startIndex..<space].allSatisfy({ $0.isNumber || $0 == "." }) {
                flushParagraph()
                if bullets.isEmpty == false { flushLists() }
                var rest = line[line.index(after: space)...]
                if rest.first == " " { rest = rest.dropFirst() }
                numbers.append(String(rest))
            } else {
                flushLists()
                paragraphLines.append(line)
            }
        }
        flushTable()
        flushParagraph()
        flushLists()
        if inCode { result.append(.code(lines: codeLines)) }
        return result
    }

    // MARK: - 块渲染

    @ViewBuilder
    private func blockView(_ block: Block) -> some View {
        switch block {
        case .heading(let level, let text):
            inlineText(text)
                .font(theme.font(headingScale(level), weight: .bold))
                .foregroundStyle(theme.foreground)
                .padding(.top, level <= 2 ? theme.space(.sm) : 0)
        case .paragraph(let text):
            inlineText(text)
                .font(theme.font(.fs14))
                .foregroundStyle(theme.foreground)
                .lineSpacing(6)
        case .bulletList(let items):
            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: theme.space(.sm)) {
                        Text("•").foregroundStyle(theme.muted)
                        inlineText(item)
                    }
                    .font(theme.font(.fs14))
                    .foregroundStyle(theme.foreground)
                }
            }
        case .numberedList(let items):
            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: theme.space(.sm)) {
                        Text("\(index + 1).").foregroundStyle(theme.muted)
                        inlineText(item)
                    }
                    .font(theme.font(.fs14))
                    .foregroundStyle(theme.foreground)
                }
            }
        case .quote(let text):
            HStack(alignment: .firstTextBaseline, spacing: theme.space(.sm)) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(theme.border)
                    .frame(width: 3)
                inlineText(text)
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.muted)
            }
        case .divider:
            Divider().overlay(theme.borderSoft)
        case .table(let header, let rows):
            VStack(alignment: .leading, spacing: 0) {
                tableRow(header, bold: true)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Divider().overlay(theme.borderSoft)
                    tableRow(row, bold: false)
                }
            }
            .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).fill(theme.surface))
            .clipShape(RoundedRectangle(cornerRadius: theme.radius(.sm)))
            .overlay(RoundedRectangle(cornerRadius: theme.radius(.sm)).stroke(theme.borderSoft))
        case .code(let lines):
            Text(lines.joined(separator: "\n"))
                .font(theme.font(.fs13, weight: .regular, mono: true))
                .foregroundStyle(theme.foregroundSoft)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(theme.space(.md))
                .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).fill(theme.background))
        }
    }

    private func tableRow(_ cells: [String], bold: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.space(.md)) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                inlineText(cell)
                    .font(theme.font(.fs13, weight: bold ? GeistWeight.medium : GeistWeight.regular))
                    .foregroundStyle(bold ? theme.foreground : theme.foregroundSoft)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, theme.space(.md))
        .padding(.vertical, theme.space(.sm))
    }

    /// 行内样式（粗体/斜体/代码/链接）交给 AttributedString inline-only 解析；
    /// 解析失败按纯文本回退。
    private func inlineText(_ raw: String) -> Text {
        if let attributed = try? AttributedString(
            markdown: raw,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return Text(attributed)
        }
        return Text(raw)
    }

    private func headingScale(_ level: Int) -> FontScale {
        switch level {
        case 1: .fs20
        case 2: .fs18
        default: .fs15
        }
    }
}
