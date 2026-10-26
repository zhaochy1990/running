import Foundation
import Observation

// 产品路线面板 ViewModel（devops#553/#554，PR-7 收尾域 devops#770）：
// 三区平铺不折叠（最近上线时间线 / 正在做 / 投票池）；投票乐观更新 +
// 本地重排不重拉列表；失败回滚 + 静默重拉对齐服务端（弱网下请求可能已
// 生效）；同想法连点 in-flight 串行化。feedback 二级 tab 与 product-roadmap
// 薄壳共用。

@MainActor
@Observable
public final class RoadmapPanelModel {

    // ── 三区行投影（列表只渲染概述 blurb，markdown 正文在详情页）────────
    public struct ReleasedRow: Equatable, Identifiable, Sendable {
        public let id: Int
        /// 上海日期 2026.10.14 样式。
        public let date: String
        public let title: String
        public let blurb: String
        /// 发布时票数快照（「由 N 位跑友投票促成」）。
        public let proof: Int
    }

    public struct AcceptedRow: Equatable, Identifiable, Sendable {
        public let id: Int
        public let title: String
        public let blurb: String
        /// 预计上线说明，空则隐藏 chip。
        public let plannedNote: String
        public let votes: Int
    }

    public struct PoolRow: Equatable, Identifiable, Sendable, PoolVoteRow {
        public let id: Int
        public let title: String
        public let blurb: String
        public let category: String
        public let isNew: Bool
        public let votes: Int
        public let voted: Bool

        public func withVoteState(voted: Bool, votes: Int) -> PoolRow {
            PoolRow(id: id, title: title, blurb: blurb, category: category,
                    isNew: isNew, votes: votes, voted: voted)
        }
    }

    public private(set) var loading = true
    public private(set) var loadError = ""
    public private(set) var releasedRows: [ReleasedRow] = []
    public private(set) var acceptedRows: [AcceptedRow] = []
    public private(set) var poolRows: [PoolRow] = []

    public internal(set) var toastMessage: String?

    /// 在飞的投票 feature id：同一想法的连点直接忽略（in-flight 串行化）。
    private var voting: Set<Int> = []
    private var fetchSeq = 0
    private var app: AppModel?
    private var started = false

    public init() {}

    // MARK: - 生命周期

    /// 宿主挂载时装配（attached 等价）；重复调用幂等。
    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await fetch()
    }

    /// 宿主 onShow 静默刷新（已有数据不闪 loading）。
    public func fetch() async {
        guard let app else { return }
        let seq = fetchSeq + 1
        fetchSeq = seq
        let hasData = !poolRows.isEmpty || !releasedRows.isEmpty || !acceptedRows.isEmpty
        if !hasData {
            loading = true
            loadError = ""
        }
        do {
            let res = try await app.api.roadmap()
            guard seq == fetchSeq else { return }
            loading = false
            loadError = ""
            releasedRows = res.released.map { item in
                ReleasedRow(
                    id: item.id,
                    date: shanghaiDateFromIso(item.releasedAt).replacingOccurrences(of: "-", with: "."),
                    title: item.title,
                    blurb: roadmapBlurb(item.summary, item.description),
                    proof: item.votesSnapshot
                )
            }
            acceptedRows = res.accepted.map { item in
                AcceptedRow(
                    id: item.id,
                    title: item.title,
                    blurb: roadmapBlurb(item.summary, item.description),
                    plannedNote: item.plannedNote,
                    votes: item.votes
                )
            }
            // 后端已按票数降序；本地保序，后续投票在客户端重排。
            poolRows = res.backlog.map { item in
                PoolRow(
                    id: item.id,
                    title: item.title,
                    blurb: roadmapBlurb(item.summary, item.description),
                    category: item.category,
                    isNew: item.isNew,
                    votes: item.votes,
                    voted: item.voted
                )
            }
        } catch {
            guard seq == fetchSeq else { return }
            loading = false
            loadError = (error as? ApiError)?.message ?? "加载失败"
        }
    }

    // MARK: - 投票（乐观 + 本地重排 + 失败回滚静默重拉）

    public func toggleVote(_ id: Int) async {
        guard let app, !voting.contains(id),
              let row = poolRows.first(where: { $0.id == id }) else { return }

        let adding = !row.voted
        let prevRows = poolRows
        // 乐观更新 + 本地重排（不重拉列表，devops#553）。
        poolRows = togglePoolVote(prevRows, id: id)
        toastMessage = adding ? "已投票 · 再点一次可撤销" : "已撤销这一票"

        voting.insert(id)
        defer { voting.remove(id) }
        do {
            if adding {
                _ = try await app.api.voteRoadmapFeature(id)
            } else {
                _ = try await app.api.unvoteRoadmapFeature(id)
            }
        } catch {
            // 回滚乐观更新；静默重拉对齐服务端（弱网下请求可能已生效）。
            poolRows = prevRows
            let apiError = error as? ApiError
            toastMessage = apiError?.code == "not_votable" ? "该想法已排期，暂不可投" : "投票失败"
            await fetch()
        }
    }
}
