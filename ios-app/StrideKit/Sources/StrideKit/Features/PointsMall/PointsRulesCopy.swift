import Foundation

// MARK: - 积分商城域规则弹窗文案（devops#938 拍板 5）
//
// 底稿 = mp 两份规则弹窗（checkin.wxml / points-mall.wxml），品牌「砺跑马拉松
// 助手」→ StrideWise、平台词「小程序」→ App、微信专属条款改写为 App 语境。
// 初稿随 PR 正文给用户过目（票面拍板），上线前法务复核两段平台专属条款。

public struct RulesBlock: Hashable, Sendable, Identifiable {
    public enum Kind: Hashable, Sendable {
        /// 段落。
        case paragraph
        /// 小节标题。
        case heading
        /// 提示条（浅底强调）。
        case tip
    }

    public let id: Int
    public let kind: Kind
    public let text: String

    init(_ id: Int, _ kind: Kind, _ text: String) {
        self.id = id
        self.kind = kind
        self.text = text
    }
}

public struct RulesDocument: Hashable, Sendable {
    public let title: String
    public let blocks: [RulesBlock]

    init(title: String, blocks: [RulesBlock]) {
        self.title = title
        self.blocks = blocks
    }
}

/// 签到福利规则（mp checkin.wxml:125-144 改写：品牌 6 处 + 小程序→App 2 处）。
public let checkinRulesDocument = RulesDocument(title: "StrideWise 签到福利规则", blocks: [
    RulesBlock(0, .paragraph, "参与 StrideWise 签到福利的用户，可以根据连续签到的天数获得相对应的积分奖励。"),
    RulesBlock(1, .heading, "一、签到周期"),
    RulesBlock(2, .paragraph, "以 7 天为一个签到循环轮次。一旦签到中断，连续签到天数立即清零，下一次签到重新从第 1 天开始计算；不间断连续签到满 7 天后，自动开启新一轮 7 天签到循环，奖励规则保持不变。"),
    RulesBlock(3, .heading, "二、奖励说明"),
    RulesBlock(4, .paragraph, "常规签到奖励：连续签到第 1–4 天，每日签到可领取 1 积分；连续签到第 5–6 天，每日签到可领取 2 积分；连续签到第 7 天，签到可领取 3 积分。"),
    RulesBlock(5, .tip, "提示：积分仅可在 StrideWise App 积分商城兑换指定礼品，积分无现金价值，不能提现、转账、售卖。积分永久有效，不会到期清零。"),
    RulesBlock(6, .heading, "三、奖励查看与领取"),
    RulesBlock(7, .paragraph, "1. 签到活动获得的积分奖励，可在【我的】-【积分明细】中查看发放记录。"),
    RulesBlock(8, .paragraph, "2. 签到奖励在当日完成签到后，自动发放到您的登录账户。"),
    RulesBlock(9, .heading, "四、其他说明"),
    RulesBlock(10, .paragraph, "1. 本活动福利仅限 StrideWise App 注册用户参与，同一账号仅限本人参与活动。"),
    RulesBlock(11, .paragraph, "2. 对于利用系统漏洞、虚假操作、脚本作弊或任何非正常手段参与活动的用户，StrideWise 有权单方面取消其参与活动的资格，冻结或撤销已获得的积分权益，禁止其继续参加其他福利活动。"),
    RulesBlock(12, .paragraph, "3. 本活动由 StrideWise 提供。"),
    RulesBlock(13, .paragraph, "4. 主办方可提前在 App 公告内公示后调整活动规则或下线活动；活动最终解释权归 StrideWise 所有。"),
])

/// 积分商城兑换规则（mp points-mall.wxml:176-200 改写：品牌 5 处 + 平台词
/// 改 App 语境；第 5 条微信专属条款「与微信平台无关」删除，保留独立提供声明）。
public let mallRulesDocument = RulesDocument(title: "StrideWise 积分商城兑换规则", blocks: [
    RulesBlock(0, .paragraph, "参与 StrideWise 积分商城兑换的用户，可使用账户内积分兑换商城内指定礼品。"),
    RulesBlock(1, .tip, "重要声明：本平台积分仅为 StrideWise App 自营福利积分，无现金价值、不可折现、不可转让、不可交易，仅可用于本积分商城兑换指定礼品；积分永久有效，不会到期清零。"),
    RulesBlock(2, .heading, "一、积分来源"),
    RulesBlock(3, .paragraph, "商城内用于兑换的积分，来自 App 内签到、任务、活动等官方发放渠道，不支持充值购买积分。"),
    RulesBlock(4, .heading, "二、兑换说明"),
    RulesBlock(5, .paragraph, "1. 兑换商品所需积分以商品详情页展示数值为准，兑换时系统自动扣减对应积分；"),
    RulesBlock(6, .paragraph, "2. 商品库存实时更新，先兑先得，库存不足时无法兑换；"),
    RulesBlock(7, .paragraph, "3. 兑换订单提交成功后，积分即时扣除，积分一经扣除不予退回（商品缺货下架、主办方主动取消订单除外）；"),
    RulesBlock(8, .paragraph, "4. 兑换礼品仅限本人使用，禁止倒卖、转售兑换所得礼品。"),
    RulesBlock(9, .heading, "三、发货与售后"),
    RulesBlock(10, .paragraph, "1. 实物礼品：兑换成功后，将在公示周期内安排发货，收货信息以用户提交地址为准；地址填写错误造成无法收货，由用户自行承担；"),
    RulesBlock(11, .paragraph, "2. 虚拟礼品（跑步课程、训练计划等）：兑换成功后自动发放至账户；"),
    RulesBlock(12, .paragraph, "3. 福利兑换商品不支持 7 天无理由退换；如存在质量破损，请在签收后指定时限内联系 App 内客服核验。"),
    RulesBlock(13, .heading, "四、其他说明"),
    RulesBlock(14, .paragraph, "1. 本商城福利仅限 StrideWise App 注册用户参与，同一账号仅限本人使用；"),
    RulesBlock(15, .paragraph, "2. 如对兑换活动有疑问，可通过 App 内客服渠道咨询；"),
    RulesBlock(16, .paragraph, "3. 若用户通过脚本、刷号、系统漏洞、虚假操作等非正常方式获取积分、兑换商品，StrideWise 有权撤销兑换、收回礼品、扣除违规积分、取消活动参与资格；"),
    RulesBlock(17, .paragraph, "4. 商城商品、库存、兑换规则，主办方可以提前在 App 公告公示后进行调整、下架；"),
    RulesBlock(18, .paragraph, "5. 本积分商城活动由 StrideWise 独立提供；活动最终解释权归 StrideWise 所有。"),
])
