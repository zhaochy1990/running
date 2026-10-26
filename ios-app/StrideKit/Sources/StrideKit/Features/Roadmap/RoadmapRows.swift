import Foundation

// MARK: - 产品路线纯变换（utils/roadmapRows.ts 直译，PR-7 收尾域 devops#770）
//
// 投票/撤销的乐观更新与本地重排（devops#553：投票后不重拉列表）在这里做，
// 排序与 Go 端 backlog（票数降序、同票新想法在前）同源不漂移。
// 列表概述（roadmapBlurb）：概述优先，存量行兜底=描述去 markdown 截断，
// markdown 正文只在详情页渲染。

/// 投票池行的可变投影（页面行 / RoadmapBacklogItem 都满足）。
public protocol PoolVoteRow: Identifiable, Equatable, Sendable {
    var id: Int { get }
    var votes: Int { get }
    var voted: Bool { get }
    func withVoteState(voted: Bool, votes: Int) -> Self
}

extension RoadmapBacklogItem: PoolVoteRow {
    public func withVoteState(voted: Bool, votes: Int) -> RoadmapBacklogItem {
        RoadmapBacklogItem(id: id, title: title, summary: summary, description: description,
                           category: category, isNew: isNew, votes: votes, voted: voted)
    }
}

/// 票数降序、同票新想法（id 大）在前。返回新数组，不改入参。
public func sortPoolRows<T: PoolVoteRow>(_ rows: [T]) -> [T] {
    rows.sorted { lhs, rhs in
        if lhs.votes != rhs.votes { return lhs.votes > rhs.votes }
        return lhs.id > rhs.id
    }
}

/// 乐观 toggle 一次投票：voted 取反、票数 ±1（夹在 0 以上），并整体重排。
/// 未知 id 原样返回。（myVotes 聚合卡已随 hero 卡移除，不再单列返回值。）
public func togglePoolVote<T: PoolVoteRow>(_ rows: [T], id: Int) -> [T] {
    guard rows.contains(where: { $0.id == id }) else { return rows }
    let next = rows.map { row -> T in
        guard row.id == id else { return row }
        let adding = !row.voted
        return row.withVoteState(voted: adding, votes: max(0, row.votes + (adding ? 1 : -1)))
    }
    return sortPoolRows(next)
}

// ── 列表概述（blurb）─────────────────────────────────────────────

/// 列表概述的最大字符数（与管理端概述输入上限、后端 max=50 同源）。
public let roadmapBlurbMax = 50

/// 去掉 markdown 结构符号，取近似纯文本（列表兜底渲染用，尽力而为）。
public func stripMarkdownish(_ text: String) -> String {
    var out = text
    let patterns: [(String, String)] = [
        ("```[\\s\\S]*?```", " "),          // 围栏代码块
        ("!\\[([^\\]]*)\\]\\([^)]*\\)", "$1"), // 图片 → alt
        ("\\[([^\\]]*)\\]\\([^)]*\\)", "$1"),  // 链接 → 文字
        ("(?m)^\\s{0,3}#{1,6}\\s+", ""),       // 标题记号
        ("(?m)^\\s{0,3}>\\s?", ""),            // 引用记号
        ("(?m)^\\s{0,3}[-+*]\\s+", ""),        // 无序列表记号
        ("(?m)^\\s{0,3}\\d+\\.\\s+", ""),      // 有序列表记号
        ("`([^`]*)`", "$1"),                   // 行内 code
        ("\\*([^*\\n]*)\\*", "$1"),            // 加粗/斜体星号
        ("__", ""),
        ("\\|", " "),                          // 表格分隔线
    ]
    for (pattern, replacement) in patterns {
        out = out.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
    }
    return out
}

/// 列表行文案：概述优先；无概述 → 描述去 markdown 后截到上限（超出补省略号）。
public func roadmapBlurb(_ summary: String?, _ description: String) -> String {
    let trimmed = (summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { return trimmed }
    let plain = stripMarkdownish(description)
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
    if plain.count <= roadmapBlurbMax { return plain }
    return String(plain.prefix(roadmapBlurbMax)) + "…"
}

/// 上海时区 RFC3339（released_at）→ 日期串。取前 10 位语义上安全（后端
/// 已按上海偏移序列化），但统一走 `Shanghai` 完成解析归一。
public func shanghaiDateFromIso(_ iso: String) -> String {
    String(iso.prefix(10))
}
