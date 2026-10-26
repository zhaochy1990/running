import Foundation
import Testing
@testable import StrideKit

/// SSE 解析器语义测试（对齐 Dart/TS 版行为：任意字节边界、多字节 UTF-8
/// 安全、CRLF、注释行、flush 截断恢复、malformed → U+FFFD）。
@Suite struct SSEParserTests {

    private func eventBytes(_ wire: String) -> [UInt8] { Array(wire.utf8) }

    // MARK: - 基本解析

    @Test func parsesCompleteEvents() {
        var parser = SSEParser()
        let events = parser.feed(eventBytes(
            "event: status\ndata: {\"phase\":\"analyzing\"}\n\n" +
            "event: text_delta\ndata: {\"delta\":\"你好\"}\n\n"
        ))
        #expect(events.count == 2)
        #expect(events[0] == .init(event: "status", data: "{\"phase\":\"analyzing\"}"))
        #expect(events[1] == .init(event: "text_delta", data: "{\"delta\":\"你好\"}"))
        #expect(parser.flush().isEmpty)
    }

    @Test func handlesCRLFTerminators() {
        var parser = SSEParser()
        let events = parser.feed(eventBytes("event: done\r\ndata: {\"status\":\"completed\"}\r\n\r\n"))
        #expect(events.count == 1)
        #expect(events[0].event == "done")
    }

    @Test func skipsCommentLinesAndJoinsMultiLineData() {
        var parser = SSEParser()
        let events = parser.feed(eventBytes(": keep-alive\nevent: narration\ndata: line1\ndata: line2\n\n"))
        #expect(events.count == 1)
        #expect(events[0].event == "narration")
        #expect(events[0].data == "line1\nline2")
    }

    @Test func parsesOptionalIdField() {
        var parser = SSEParser()
        let events = parser.feed(eventBytes("id: 42\nevent: status\ndata: {}\n\n"))
        #expect(events[0].id == "42")
    }

    @Test func valueWithoutColonIsWholeLineField() {
        var parser = SSEParser()
        // SSE 规范：无冒号行 = 字段名整行 + 空值（event 字段被置空，与 TS 版同口径）。
        let events = parser.feed(eventBytes("event\n\n"))
        #expect(events[0].event == "")
        #expect(events[0].data.isEmpty)
    }

    // MARK: - 任意字节边界（逐字节喂入）

    @Test func feedsSingleByteAtATime() {
        var parser = SSEParser()
        var collected: [SSEParser.Event] = []
        for byte in eventBytes("event: text_delta\ndata: {\"delta\":\"配速 5:00/km\"}\n\n") {
            collected.append(contentsOf: parser.feed([byte]))
        }
        #expect(collected.count == 1)
        #expect(collected[0].event == "text_delta")
        #expect(collected[0].data == "{\"delta\":\"配速 5:00/km\"}")
    }

    @Test func splitsAcrossArbitraryChunkBoundaries() {
        let bytes = eventBytes(
            "event: status\ndata: {\"phase\":\"running_tool\"}\n\n" +
            "event: text_delta\ndata: {\"delta\":\"分段\"}\n\n"
        )
        // 固定种子的伪随机切分，覆盖 1/2/3/5/7 字节步长。
        for step in [1, 2, 3, 5, 7] {
            var parser = SSEParser()
            var collected: [SSEParser.Event] = []
            var index = 0
            while index < bytes.count {
                let end = min(index + step, bytes.count)
                collected.append(contentsOf: parser.feed(Array(bytes[index..<end])))
                index = end
            }
            #expect(collected.count == 2, "step=\(step)")
            #expect(collected[0].event == "status")
            #expect(collected[1].event == "text_delta")
        }
    }

    @Test func multiByteUtf8SplitMidCodePoint() {
        // 「马」= 3 字节码点；在码点中间切分，凑齐完整块才解码。
        let text = "{\"delta\":\"马\"}"
        var parser = SSEParser()
        let bytes = eventBytes("event: text_delta\ndata: \(text)\n\n")
        let cut = bytes.count / 2
        let first = parser.feed(Array(bytes[..<cut]))
        #expect(first.isEmpty, "半个事件不产出")
        let second = parser.feed(Array(bytes[cut...]))
        #expect(second.count == 1)
        #expect(second[0].data == text)
    }

    // MARK: - flush 截断恢复

    @Test func flushRecoversTruncatedFinalEvent() {
        var parser = SSEParser()
        let events = parser.feed(eventBytes("event: done\ndata: {\"status\":\"completed\"}"))
        #expect(events.isEmpty)
        let flushed = parser.flush()
        #expect(flushed.count == 1)
        #expect(flushed[0].event == "done")
        #expect(flushed[0].data == "{\"status\":\"completed\"}")
    }

    @Test func malformedUtf8BecomesReplacement() {
        var parser = SSEParser()
        // 非法 UTF-8 序列（0xFF 0xFE）后接合法内容：不抛错，替换为 U+FFFD。
        var bytes: [UInt8] = "event: text_delta\ndata: ".utf8.map { $0 }
        bytes += [0xFF, 0xFE]
        bytes += Array("\n\n".utf8)
        let events = parser.feed(bytes)
        #expect(events.count == 1)
        #expect(events[0].data.contains("\u{FFFD}"))
    }

    @Test func partialTerminatorNotEmittedEarly() {
        var parser = SSEParser()
        // 只有单个 \n：不是事件边界。
        let events = parser.feed(eventBytes("event: status\ndata: {}\n"))
        #expect(events.isEmpty)
        let done = parser.feed(eventBytes("\n"))
        #expect(done.count == 1)
    }

    // MARK: - findEventEnd 边界

    @Test func crlfBeforeLfScan() {
        // "\r\n\r\n" 内不含 "\n\n"，先扫 4 字节终止符；两个都能解析。
        var parser = SSEParser()
        let events = parser.feed(eventBytes("event: a\ndata: 1\r\n\r\nevent: b\ndata: 2\n\n"))
        #expect(events.map(\.event) == ["a", "b"])
    }
}
