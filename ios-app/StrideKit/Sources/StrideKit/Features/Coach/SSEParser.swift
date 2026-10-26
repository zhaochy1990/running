import Foundation

/// 字节级增量 SSE（Server-Sent Events）解析器 —— `mobile/lib/data/coach/sse_parser.dart`
/// 的 Swift 直译（devops#767 PR-4；原链路 MP `utils/sse.ts` → Flutter → 本文件）。
///
/// coach 后端经 Hono `stream.writeSSE` 下发：
///
///     event: status\n     data: {"turn_id":"...","phase":"..."}\n\n
///     event: text_delta\n data: {"turn_id":"...","delta":"..."}\n\n
///     event: done\n       data: {"turn_id":"...","status":"completed","message":"..."}\n\n
///     event: error\n      data: {"turn_id":"...","code":"...","message":"..."}\n\n
///
/// 网络分块落在任意字节边界：字节先累积，凑齐完整事件终止符（`\n\n` 或
/// `\r\n\r\n`）才解码——终止符是单个 ASCII 字节，绝不会落在多字节 UTF-8 码点
/// 中间，因此「只解码完整块」天然多字节安全。`flush()` 在连接关闭时恢复被
/// 截断的尾部事件（无终止符的残余块）。
///
/// 勿用 EventSource 库（票面硬约束）：POST + Accept 流 + 自研解析器。
public struct SSEParser: Sendable {

    /// 一条已解析的 SSE 事件（`event:` + 拼接的 `data:` 行 + 可选 `id:`）。
    public struct Event: Equatable, Sendable {
        public let event: String
        public let data: String
        public let id: String?

        public init(event: String, data: String, id: String? = nil) {
            self.event = event
            self.data = data
            self.id = id
        }
    }

    private var buffer: [UInt8] = []

    public init() {}

    /// 喂入一批字节，按到达序产出其中所有完整事件。
    public mutating func feed(_ bytes: [UInt8]) -> [Event] {
        guard !bytes.isEmpty else { return [] }
        buffer.append(contentsOf: bytes)
        var events: [Event] = []
        while let end = Self.findEventEnd(buffer) {
            let block = Array(buffer[0..<end])
            buffer.removeFirst(end)
            events.append(Self.parseEventBlock(block))
        }
        return events
    }

    /// 流结束时冲刷残余：把尚未终止的最后一块按事件解析（截断恢复兜底）。
    public mutating func flush() -> [Event] {
        guard !buffer.isEmpty else { return [] }
        let block = buffer
        buffer = []
        return [Self.parseEventBlock(block)]
    }

    /// 下一个事件终止符之后的位置；缓冲区不足时返回 nil。
    ///
    /// 先扫 CRLF-CRLF（4 字节），再扫 LF-LF（2 字节）——与 TS/Dart 版同序：
    /// `\r\n\r\n` 里不含连续 `\n\n`，两种终止符互不误伤。
    static func findEventEnd(_ buf: [UInt8]) -> Int? {
        guard buf.count >= 4 else {
            // 不足 4 字节时 LF-LF 仍可能成对（如 "\n\n" 恰好收尾）。
            if buf.count >= 2 {
                for i in 0...(buf.count - 2) where buf[i] == 10 && buf[i + 1] == 10 {
                    return i + 2
                }
            }
            return nil
        }
        for i in 0...(buf.count - 4) where buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10 {
            return i + 4
        }
        for i in 0...(buf.count - 2) where buf[i] == 10 && buf[i + 1] == 10 {
            return i + 2
        }
        return nil
    }

    /// 单个事件块（无终止符）→ Event。注释行（`:` 开头）跳过；`data:` 多行拼接。
    static func parseEventBlock(_ block: [UInt8]) -> Event {
        // allowMalformed 与 TS/Dart 版同口径：非法/截断序列变 U+FFFD，不中断流。
        var decoder = UTF8()
        var text = String()
        var iterator = block.makeIterator()
        loop: while true {
            switch decoder.decode(&iterator) {
            case .scalarValue(let v): text.unicodeScalars.append(v)
            case .emptyInput: break loop
            case .error: text.unicodeScalars.append("\u{FFFD}")
            }
        }
        text = text.replacingOccurrences(of: "\r\n", with: "\n")

        var event = ""
        var id: String?
        var dataLines: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.isEmpty { continue }
            if line.hasPrefix(":") { continue } // 注释 / keep-alive 行
            let colon = line.firstIndex(of: ":")
            let field = colon.map { String(line[line.startIndex..<$0]) } ?? String(line)
            var value = colon.map { String(line[line.index(after: $0)...]) } ?? ""
            if value.hasPrefix(" ") { value.removeFirst() }
            switch field {
            case "event": event = value
            case "id": id = value
            case "data": dataLines.append(value)
            default: break // retry 等未知字段忽略
            }
        }
        return Event(event: event, data: dataLines.joined(separator: "\n"), id: id)
    }
}
