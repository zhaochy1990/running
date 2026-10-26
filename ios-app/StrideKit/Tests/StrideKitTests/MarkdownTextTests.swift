import Foundation
import Testing
@testable import StrideKit

/// 声明正文 markdown 块解析冒烟（mp-html 的 SwiftUI 方案，mapping.md 转译约定）。
@Suite struct MarkdownTextTests {

    private func blocks(_ markdown: String) -> [MarkdownText.Block] {
        MarkdownText(markdown, theme: LightTheme()).blocks
    }

    @Test func parsesHeadingParagraphAndLists() {
        let result = blocks("""
        # 用户协议

        欢迎使用 STRIDE。

        - 第一条
        - 第二条

        1. 步骤一
        2. 步骤二
        """)
        #expect(result == [
            .heading(level: 1, text: "用户协议"),
            .paragraph("欢迎使用 STRIDE。"),
            .bulletList(items: ["第一条", "第二条"]),
            .numberedList(items: ["步骤一", "步骤二"]),
        ])
    }

    @Test func parsesTableQuoteDividerAndFence() {
        let result = blocks("""
        > 免责声明

        ---

        | 条款 | 内容 |
        | --- | --- |
        | 期限 | 长期 |

        ```
        code block
        ```
        """)
        #expect(result == [
            .quote("免责声明"),
            .divider,
            .table(header: ["条款", "内容"], rows: [["期限", "长期"]]),
            .code(lines: ["code block"]),
        ])
    }

    @Test func unknownHeadingDepthFallsIntoH4AndInlineKept() {
        let result = blocks("##### 小标题\n正文 **加粗**")
        #expect(result == [
            .heading(level: 4, text: "小标题"),
            .paragraph("正文 **加粗**"),
        ])
    }
}
