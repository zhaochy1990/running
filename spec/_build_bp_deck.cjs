// StrideWise Coach BP 融资路演 PPT —— 基于 StrideWise_COACH_BP.md 构建
// 运行：node _build_bp_deck.js  （需全局 pptxgenjs）
const pptxgen = require("pptxgenjs");

// ---------- 设计系统：对齐产品品牌（#FF6363 藕粉 × #101111 深色） ----------
const BG_DARK = "101111";   // 封面/封底深色底
const BG      = "FFFFFF";   // 内容页白底
const INK     = "1D1D24";   // 主文字
const MUTED   = "85858F";   // 次要文字
const ACCENT  = "FF6363";   // 唯一强调色（5–10%）
const TINT    = "FDF0EF";   // accent 极浅 tint（卡片底）
const TINT2   = "F5F5F7";   // 中性浅灰（卡片底）
const LINE    = "E7E7EB";   // 发丝线
const W_MUTED = "A9A9B4";   // 深色页次要文字
const YH = "PingFang SC";

const W = 13.33, H = 7.5, M = 0.6;
const CW = W - 2 * M; // 12.13 内容宽

let p = new pptxgen();
p.layout = "LAYOUT_WIDE";
p.author = "StrideWise";
p.title = "StrideWise 商业计划书";

const T = (s, txt, o) => s.addText(txt, { fontFace: YH, margin: 0, ...o });
const card = (s, x, y, w, h, fill, shadow) => s.addShape("roundRect", {
  x, y, w, h, fill: { color: fill }, rectRadius: 0.07,
  line: { type: "none" },
  ...(shadow ? { shadow: { type: "outer", color: "000000", blur: 7, offset: 2, angle: 90, opacity: 0.10 } } : {}),
});
const bu = () => ({ code: "25B8", indent: 10, color: ACCENT });

function footer(s, n) {
  T(s, "StrideWise 商业计划书 · 机密", { x: M, y: 7.08, w: 4, h: 0.3, fontSize: 12, color: MUTED });
  T(s, `${String(n).padStart(2, "0")} / 14`, { x: W - M - 1.2, y: 7.08, w: 1.2, h: 0.3, fontSize: 12, color: MUTED, align: "right" });
}
function header(s, title, sub) {
  T(s, title, { x: M, y: 0.52, w: CW, h: 0.62, fontSize: 30, bold: true, color: INK });
  if (sub) T(s, sub, { x: M, y: 1.18, w: CW, h: 0.4, fontSize: 14, color: MUTED });
}

// ---------- 1 封面（深） ----------
(() => {
  const s = p.addSlide();
  s.background = { color: BG_DARK };
  T(s, "StrideWise", { x: M, y: 1.5, w: CW, h: 1.3, fontSize: 76, bold: true, color: "FFFFFF", charSpacing: 4 });
  s.addShape("rect", { x: M + 0.06, y: 2.98, w: 0.62, h: 0.09, fill: { color: ACCENT }, line: { type: "none" } });
  T(s, "装在口袋里的 AI 跑步教练", { x: M, y: 3.22, w: CW, h: 0.62, fontSize: 28, bold: true, color: "FFFFFF" });
  T(s, "记得住你的身体状态、训练历史与目标赛事 —— 覆盖跑者从入坑到 PB 的完整生命周期", {
    x: M, y: 3.95, w: CW, h: 0.45, fontSize: 15, color: W_MUTED });
  const stats = [
    ["1.63 亿", "中国跑步人口"],
    ["454 万人次", "2025 马拉松参赛（+9.1%）"],
    ["¥29/月", "专业教练级指导定价"],
  ];
  stats.forEach((it, i) => {
    const x = M + i * (CW / 3);
    T(s, it[0], { x, y: 5.15, w: CW / 3 - 0.3, h: 0.62, fontSize: 34, bold: true, color: ACCENT });
    T(s, it[1], { x, y: 5.82, w: CW / 3 - 0.3, h: 0.35, fontSize: 13, color: W_MUTED });
  });
  T(s, "商业计划书 · 2026 年 10 月 ｜ 机密，仅供指定投资人评估", { x: M, y: 6.85, w: CW, h: 0.35, fontSize: 12, color: W_MUTED });
})();

// ---------- 2 问题（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "1.63 亿跑者，同一个困境", "数据在手腕上，决策全凭感觉");
  card(s, M, 1.85, 3.55, 4.35, TINT);
  T(s, "1.63 亿", { x: M + 0.3, y: 2.45, w: 3, h: 1.05, fontSize: 60, bold: true, color: ACCENT });
  T(s, "中国跑步人口（2024）", { x: M + 0.3, y: 3.55, w: 3, h: 0.4, fontSize: 14, color: INK });
  s.addShape("line", { x: M + 0.3, y: 4.15, w: 2.9, h: 0, line: { color: "F0D2D0", width: 1 } });
  T(s, "2025 马拉松参赛 454 万人次（+9.1%）、认证赛事完赛 260 万人次；跑者年均消费 ¥3,362，七成月入过万", {
    x: M + 0.3, y: 4.32, w: 2.95, h: 1.6, fontSize: 13, color: INK, lineSpacingMultiple: 1.25 });
  const pains = [
    ["凭感觉训练", "不懂周期化与负荷管理 —— 过度训练受伤，或长期原地踏步"],
    ["数据用不起来", "手表有各类分析指标，但变不成「这周怎么排、备赛周期怎么走」的决策"],
    ["专业指导难获得", "教练贵且受地域限制，本地未必有同水平教练；训练营是群发计划"],
    ["需求是整体的", "营养、恢复、伤病、选赛、装备 —— 没有一个连贯入口"],
  ];
  pains.forEach((it, i) => {
    const y = 1.85 + i * 1.12;
    T(s, it[0], { x: 4.55, y, w: 3.1, h: 0.42, fontSize: 17, bold: true, color: INK });
    T(s, it[1], { x: 4.55, y: y + 0.42, w: 8.1, h: 0.42, fontSize: 13.5, color: MUTED });
    if (i < 3) s.addShape("line", { x: 4.55, y: y + 0.98, w: 8.15, h: 0, line: { color: LINE, width: 1 } });
  });
  T(s, "对备赛跑者（冲 PB）与健康跑用户同样成立 —— 都需要科学、个性化、可负担、随时随地的指导。", {
    x: 4.55, y: 6.4, w: 8.15, h: 0.38, fontSize: 13, color: ACCENT, bold: true });
  T(s, "来源：中国田协《2025 中国马拉松赛事蓝皮书》（2026-04）、《2024 年中国路跑工作报告》", { x: 4.55, y: 6.82, w: 8.15, h: 0.3, fontSize: 12, color: MUTED });
  footer(s, 2);
})();

// ---------- 3 Why Now（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "为什么是现在：三浪交汇", "人群、数据、AI 三项条件在 2025–2026 同时就位");
  const cols = [
    ["454 万人次", "跑步成为生活方式", ["2025 全国马拉松赛事 594 场、参赛 454.09 万人次（+9.1%）", "认证赛事完赛 260 万人次，38.5 万人刷新 PB", "A 类赛事直接经济影响 185 亿元（+16.8%）"]],
    ["84%", "穿戴设备完成数据基建", ["马拉松赛事跑者 84% 使用穿戴设备", "智能手表年出货 >3,500 万部", "手表有负荷/VO2max 等分析，但不做路跑备赛的周期化专业指导——到「备赛决策」的最后一公里是空的"]],
    ["2025", "AI 能力到达临界点", ["大模型 + 个体数据，教练级指导边际成本趋零", "Runna 被 Strava 收购，全球品类已验证", "但它不进中国：无中文、无本土支付、Strava 大陆受限"]],
  ];
  cols.forEach((c, i) => {
    const x = M + i * (CW / 3 + 0.06), w = CW / 3 - 0.25;
    card(s, x, 1.8, w, 4.15, i === 2 ? TINT : TINT2);
    T(s, c[0], { x: x + 0.28, y: 2.05, w: w - 0.56, h: 0.75, fontSize: 40, bold: true, color: i === 2 ? ACCENT : INK });
    T(s, c[1], { x: x + 0.28, y: 2.85, w: w - 0.56, h: 0.4, fontSize: 16, bold: true, color: INK });
    T(s, c[2].map((t, j) => ({ text: t, options: { bullet: bu(), breakLine: j < c[2].length - 1 } })), {
      x: x + 0.28, y: 3.42, w: w - 0.5, h: 2.3, fontSize: 12.5, color: INK, paraSpaceAfter: 10, valign: "top" });
  });
  T(s, [
    { text: "窗口期：", options: { bold: true, color: ACCENT } },
    { text: "全球品类已验证；中文市场 Sigma/RQ/PaceMate 均未确立 —— 格局未定，卡位窗口仍在。", options: { color: INK } },
  ], { x: M, y: 6.3, w: CW, h: 0.5, fontSize: 16 });
  footer(s, 3);
})();

// ---------- 4 解决方案（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "解决方案：对话式 AI 跑步教练", "一个对话框，说任意诉求；一条会话贯穿整个赛季");
  T(s, "「记得住你身体状态、训练历史、目标赛事的跑步教练」", {
    x: M, y: 1.78, w: CW, h: 0.55, fontSize: 21, bold: true, color: INK });
  // 左：对话即入口
  card(s, M, 2.55, 5.85, 3.6, TINT2);
  T(s, "对话即入口", { x: M + 0.3, y: 2.8, w: 5.2, h: 0.4, fontSize: 16, bold: true, color: INK });
  T(s, [
    { text: "「帮我排一个杭马备战计划」", options: { bullet: bu(), breakLine: true } },
    { text: "「明天下雨，强度课挪到今天」", options: { bullet: bu(), breakLine: true } },
    { text: "「我最近状态怎么样？」", options: { bullet: bu(), breakLine: true } },
    { text: "「跟腱有点疼，还能跑吗？」", options: { bullet: bu(), breakLine: true } },
    { text: "「推荐双速度训练的跑鞋」", options: { bullet: bu() } },
  ], { x: M + 0.3, y: 3.3, w: 5.3, h: 2.1, fontSize: 13.5, color: INK, paraSpaceAfter: 9 });
  T(s, "系统识别意图 → 路由到 11 个专家智能体作答或给出计划卡片", { x: M + 0.3, y: 5.62, w: 5.3, h: 0.4, fontSize: 12.5, color: MUTED });
  // 右：主动教练
  card(s, 6.88, 2.55, 5.85, 3.6, TINT);
  T(s, "主动教练（push）—— 留存核心", { x: 7.18, y: 2.8, w: 5.3, h: 0.4, fontSize: 16, bold: true, color: ACCENT });
  T(s, "真教练会主动提醒、预警、督促，而不是等用户来问：", { x: 7.18, y: 3.28, w: 5.3, h: 0.4, fontSize: 13, color: INK });
  T(s, [
    { text: "「HRV 连续走低，建议今天降强度」", options: { bullet: bu(), breakLine: true } },
    { text: "「今天该跑 8K 轻松跑了」", options: { bullet: bu(), breakLine: true } },
    { text: "「杭马报名明天截止」", options: { bullet: bu(), breakLine: true } },
    { text: "「竞速鞋已跑 600K，该换了」", options: { bullet: bu() } },
  ], { x: 7.18, y: 3.75, w: 5.3, h: 1.8, fontSize: 13.5, color: INK, paraSpaceAfter: 9 });
  T(s, "基于个体数据与计划进度触发 —— 像装在手机里、时刻在线的私人教练", { x: 7.18, y: 5.62, w: 5.3, h: 0.4, fontSize: 12.5, color: MUTED });
  T(s, "教练的规矩：动你的课表必先问你 ｜ 伤病只提醒、不擅作主张 ｜ 每条建议都有训练学/运动医学出处 ｜ 推荐只因适合你，推广会明说", {
    x: M, y: 6.42, w: CW, h: 0.45, fontSize: 12.5, color: MUTED });
  footer(s, 4);
})();

// ---------- 5 产品全景（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "产品全景：11 个模块，三层战略", "第一原则：订阅护城河 = 训练服务的完整性");
  const rows = [
    ["核心命脉", "订阅引擎", "训练计划 · 数据洞察 · 身体健康 · 营养 · 恢复 · 比赛策略 · 环境改课 · 知识", TINT, ACCENT],
    ["外部世界", "导购引擎", "装备 · 比赛发现 · 酒店（接外部真实数据，个体语境精准推荐，免费用户同样变现）", TINT2, INK],
    ["社区", "引流", "跑团 · PB 庆祝 · 排行 · 老带新（拉新与留存，后续品牌/广告）", TINT2, INK],
  ];
  rows.forEach((r, i) => {
    const y = 1.85 + i * 1.32, h = 1.14;
    card(s, M, y, CW, h, r[3]);
    T(s, r[0], { x: M + 0.35, y: y + 0.16, w: 2.1, h: 0.42, fontSize: 17, bold: true, color: r[4] });
    T(s, r[1], { x: M + 0.35, y: y + 0.6, w: 2.1, h: 0.36, fontSize: 12.5, color: MUTED });
    T(s, r[2], { x: M + 2.75, y: y + 0.16, w: 9.0, h: 0.85, fontSize: 13.5, color: INK, lineSpacingMultiple: 1.3, valign: "middle" });
  });
  T(s, "跑者生命周期 · 每一步都有变现点", { x: M, y: 5.95, w: CW, h: 0.36, fontSize: 13, bold: true, color: MUTED });
  const journey = ["选比赛", "定赛事", "订酒店", "排备战计划", "买竞速鞋", "赛前减量", "赛后复盘"];
  const tags = ["导流", "导流", "OTA", "订阅", "导购", "订阅", "订阅"];
  const jw = (CW - 6 * 0.14) / 7;
  journey.forEach((j, i) => {
    const x = M + i * (jw + 0.14);
    card(s, x, 6.38, jw, 0.52, i === 3 ? TINT : TINT2);
    T(s, [
      { text: j + "  ", options: { color: INK, bold: i === 3 } },
      { text: tags[i], options: { color: ACCENT, fontSize: 10.5 } },
    ], { x: x + 0.05, y: 6.38, w: jw - 0.1, h: 0.52, fontSize: 12.5, align: "center", valign: "middle" });
  });
  footer(s, 5);
})();

// ---------- 6 护城河（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "护城河：四层咬合的数据飞轮", "不是数据本身（手表厂商也有数据与分析），也不是公式（PMC/VDOT 公开）—— 是四者长期咬合");
  const cards4 = [
    ["01", "覆盖主流跑步手表", "各手表数据统一清洗 / 对齐 / 归一（对标 RQ 工程标杆）；重点：COROS / Garmin / Apple —— 严肃跑者主力设备"],
    ["02", "算法精度", "个体基线 · 负荷模型（CTL/ATL/TSB）· 瓶颈诊断；真实跑者越多越准，越难被追平"],
    ["03", "周期化执行闭环", "规划→执行→跟踪→调整，逐日适配个体；Sigma 计划已开放但浅（数据复述）、RQ 静态模板 —— 直接竞品都浅的一段"],
    ["04", "中文知识库", "训练学 + 运动医学，让伤病/营养/恢复敢答且可信；长期积累、难以速成"],
  ];
  cards4.forEach((c, i) => {
    const w = (CW - 3 * 0.24) / 4, x = M + i * (w + 0.24);
    card(s, x, 1.85, w, 2.9, TINT2, true);
    T(s, c[0], { x: x + 0.24, y: 2.05, w: w - 0.48, h: 0.55, fontSize: 26, bold: true, color: ACCENT });
    T(s, c[1], { x: x + 0.24, y: 2.62, w: w - 0.48, h: 0.62, fontSize: 14.5, bold: true, color: INK });
    T(s, c[2], { x: x + 0.24, y: 3.26, w: w - 0.48, h: 1.4, fontSize: 11.5, color: MUTED, lineSpacingMultiple: 1.2 });
  });
  // 飞轮箭头链（宽度收敛在版心内：4 卡 2.1 + 3 间距 0.5 + 尾箭头 + 循环标签）
  const fly = ["更多用户", "更多数据", "算法与推荐更准", "留存更高 + 口碑扩散"];
  const fw = 2.1, gap = 0.5, fy = 5.15;
  fly.forEach((f, i) => {
    const x = M + 0.55 + i * (fw + gap);
    card(s, x, fy, fw, 0.62, TINT);
    T(s, f, { x, y: fy, w: fw, h: 0.62, fontSize: 13, bold: true, color: INK, align: "center", valign: "middle" });
    if (i < 3) s.addShape("rightArrow", { x: x + fw + 0.07, y: fy + 0.21, w: 0.36, h: 0.2, fill: { color: ACCENT }, line: { type: "none" } });
  });
  s.addShape("rightArrow", { x: M + 0.55 + 3 * (fw + gap) + fw + 0.1, y: fy + 0.21, w: 0.36, h: 0.2, fill: { color: ACCENT }, line: { type: "none" } });
  T(s, "循环", { x: M + 0.55 + 3 * (fw + gap) + fw + 0.57, y: fy, w: 0.85, h: 0.62, fontSize: 12, color: MUTED, valign: "middle" });
  T(s, "同样一句「推荐跑鞋」：普通导购按销量排，StrideWise 按你的步频、落地、周期阶段、周跑量、伤病史推荐 —— 更可能转化、客单价更高。", {
    x: M, y: 6.15, w: CW, h: 0.45, fontSize: 13, color: INK, italic: true });
  footer(s, 6);
})();

// ---------- 7 市场规模（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "市场规模", "三层漏斗：TAM 理论天花板 → SAM 可服务细分 → SOM 三年现实份额");
  const tiers = [
    ["TAM", "4000 亿+", "跑步年消费池（1.63 亿人 × 人均 ¥3,362）", "订阅 + 导购理论可触达", 12.13, TINT2, INK],
    ["SAM", "1500–3000 万", "有手表 + 有训练/备赛意图 + 有付费力的跑者（10–18%）", "纯订阅天花板 52–104 亿元/年（Pro ¥348/年）", 9.6, TINT, INK],
    ["SOM · 3 年", "0.4–2.5 亿", "15–90 万付费用户（SAM 渗透 1–3%）", "订阅 ARR + 导购分成（Base：30 万用户 ≈ 0.8 亿 ARR）", 7.1, "FFDCDA", ACCENT],
  ];
  tiers.forEach((t, i) => {
    const w = t[4], x = M + (CW - w) / 2, y = 1.85 + i * 1.5;
    card(s, x, y, w, 1.3, t[5]);
    T(s, t[0], { x: x + 0.35, y: y + 0.18, w: 2.1, h: 0.4, fontSize: 14, bold: true, color: t[6] });
    T(s, t[1], { x: x + 0.35, y: y + 0.55, w: 3.6, h: 0.6, fontSize: 30, bold: true, color: t[6] === ACCENT ? ACCENT : INK });
    T(s, t[2], { x: x + 4.3, y: y + 0.18, w: w - 4.65, h: 0.5, fontSize: 13, color: INK, valign: "middle" });
    T(s, t[3], { x: x + 4.3, y: y + 0.68, w: w - 4.65, h: 0.5, fontSize: 12.5, color: MUTED, valign: "middle" });
  });
  T(s, "SAM 收窄逻辑：赛事 84% 穿戴渗透 × 2025 马拉松参赛 454 万/完赛 260 万人次（去重数百万严肃跑者）× 七成月入过万 —— 三条件交集。", {
    x: M, y: 6.42, w: CW, h: 0.36, fontSize: 12.5, color: INK });
  T(s, "来源：中国田协《2025 中国马拉松赛事蓝皮书》《2024 年中国路跑工作报告》、公开行业报告；交集/渗透/ARPU 为假设，需早期实测校准。", {
    x: M, y: 6.78, w: CW, h: 0.3, fontSize: 12, color: MUTED });
  footer(s, 7);
})();

// ---------- 8 竞争格局（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "竞争格局", "是否服务中国市场是分水岭 —— 直接竞品：Sigma、RQ、PaceMate");
  // 行式布局（原生表格在部分渲染器会被声明图框高度裁剪，弃用）
  const cols = [
    ["类别", M, 1.85], ["代表", 2.5, 2.35], ["模式", 4.95, 1.55], ["StrideWise 的差异", 6.6, 6.13],
  ];
  cols.forEach((c) => T(s, c[0], { x: c[1], y: 1.82, w: c[2], h: 0.3, fontSize: 12.5, bold: true, color: "FFFFFF", fill: { color: BG_DARK }, margin: 0.08 }));
  s.addShape("rect", { x: M, y: 1.82, w: CW, h: 0.3, fill: { type: "none" }, line: { type: "none" } });
  const rows = [
    ["华语 AI·数据跑步", "Sigma（上海）", "订阅", "训练计划已开放，但专业性不足 —— 资深跑者嫌其复述手表数据；我们以训练科学深度立信"],
    ["", "RQ 跑力（台北）", "订阅 $12.99/月", "分析最严谨但止步分析层：静态模板、不追踪执行 —— 我们是「全程带练」"],
    ["", "PaceMate（北京动健）", "订阅 ¥349/年", "形态最接近（对话式教练）但极早期、口碑未验证 —— 拼训练科学深度与闭环"],
    ["全球标杆（间接）", "Runna（被 Strava 收购）", "订阅 $19.99/月", "验证品类但不进中国；不吃生理信号、无双向对话、伤病口碑差"],
    ["综合运动社交", "咕咚 / 悦跑圈 / Keep", "免费+广告", "触达大但无严谨 AI 周期化教练；我们用数据深度切高客单跑者"],
    ["西方专业训练", "TrainingPeaks 等", "订阅 ~$20/月", "弱在中国本地化（赛事/装备/支付/语言）+ 对话低门槛"],
    ["手表自带", "Garmin / COROS", "免费随表", "有分析与免费模板，但泛运动大众导向、无专业周期化备赛指导、锁单一生态"],
    ["真人教练 / 训练营", "跑团私教 / 微信训练营", "数百–数千/月", "教练可达性差、训练营群发 —— 我们「可达性 × 个性化」两个都赢"],
  ];
  const rh = 0.52, ty = 2.22;
  rows.forEach((r, i) => {
    const y = ty + i * rh;
    T(s, r[0], { x: M, y, w: 1.85, h: rh, fontSize: 11.5, bold: true, color: INK, valign: "middle" });
    T(s, r[1], { x: 2.5, y, w: 2.35, h: rh, fontSize: 11.5, color: INK, valign: "middle" });
    T(s, r[2], { x: 4.95, y, w: 1.55, h: rh, fontSize: 11.5, color: MUTED, valign: "middle" });
    T(s, r[3], { x: 6.6, y, w: 6.13, h: rh, fontSize: 11.5, color: i === 2 ? ACCENT : INK, bold: i === 2, valign: "middle" });
    if (i < rows.length - 1) s.addShape("line", { x: M, y: y + rh, w: CW, h: 0, line: { color: LINE, width: 1 } });
  });
    T(s, "共性结论：欧美玩家不做中国本土化；Sigma 偏记录审美、RQ 偏数据分析、PaceMate 形态接近但未验证 —— 训练科学闭环 + 全训练服务 + 导购变现，是还没人做深的那一段。", {
    x: M, y: 6.48, w: CW, h: 0.5, fontSize: 12, color: ACCENT, bold: true });
  footer(s, 8);
})();

// ---------- 9 商业模式（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "商业模式：双引擎", "两引擎共享同一资产 —— 个体数据：订阅更专业 × 导购更精准");
  // 左：订阅引擎
  card(s, M, 1.85, 5.9, 3.5, TINT);
  T(s, "引擎一 · 订阅（recurring）", { x: M + 0.32, y: 2.1, w: 5.3, h: 0.45, fontSize: 17, bold: true, color: ACCENT });
  T(s, "变现「完整训练服务」护城河 —— 稳定现金流、估值锚", { x: M + 0.32, y: 2.58, w: 5.3, h: 0.38, fontSize: 12.5, color: INK });
  T(s, [
    { text: "规划 + 洞察 + 健康 + 营养 + 恢复 + 改课 + 比赛策略 + 知识", options: { bullet: bu(), breakLine: true } },
    { text: "R1 个人订阅：¥29/月，年付 8 折 ≈ ¥278/年", options: { bullet: bu(), breakLine: true } },
    { text: "留存逻辑：服务越全，跑者越离不开", options: { bullet: bu() } },
  ], { x: M + 0.32, y: 3.1, w: 5.3, h: 1.9, fontSize: 13, color: INK, paraSpaceAfter: 10 });
  // 右：导购引擎
  card(s, 6.83, 1.85, 5.9, 3.5, TINT2);
  T(s, "引擎二 · 导购分成（transactional）", { x: 7.15, y: 2.1, w: 5.3, h: 0.45, fontSize: 17, bold: true, color: INK });
  T(s, "变现「外部世界」—— 高毛利，免费用户同样变现", { x: 7.15, y: 2.58, w: 5.3, h: 0.38, fontSize: 12.5, color: INK });
  T(s, [
    { text: "R2 装备导购：跑鞋/装备 CPS 5–15%（高客单竞速鞋）", options: { bullet: bu(), breakLine: true } },
    { text: "R3 比赛报名导流：¥/单 或报名费 %", options: { bullet: bu(), breakLine: true } },
    { text: "R4 酒店/旅行：OTA 分成 4–10%（比赛周高客单）", options: { bullet: bu() } },
  ], { x: 7.15, y: 3.1, w: 5.3, h: 1.9, fontSize: 13, color: INK, paraSpaceAfter: 10 });
  // 共享资产条
  card(s, M, 5.6, CW, 0.66, BG_DARK);
  T(s, "共享资产：个体数据 —— 让订阅内容更专业、让导购推荐更精准，两边互相喂养、越用越值钱", {
    x: M, y: 5.6, w: CW, h: 0.66, fontSize: 14.5, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
  T(s, "规模化后的 B2B 放大器：R5 品牌合作/测评 ｜ R6 真人教练 marketplace（抽成 15–30%）｜ R7 匿名聚合数据洞察（隐私门控）", {
    x: M, y: 6.48, w: CW, h: 0.4, fontSize: 12.5, color: MUTED });
  footer(s, 9);
})();

// ---------- 10 定价（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "定价：三档漏斗（假设，待市场验证）", "免费档「有用到肯留存」，专业深度留在付费墙后；导购对所有档开放");
  const tiers = [
    ["Free", "¥0", ["数据同步 · 基础状态", "有限对话条数", "社区", "被导购（R2/R3 已可变现）"], TINT2, INK, false],
    ["Pro", "¥29/月", ["完整教练对话 + 赛季计划", "跑步 + 力量个性化指导", "专业分析 · 健康伤病 · 营养恢复", "比赛策略 · 无限对话"], TINT, ACCENT, true],
    ["Elite", "¥99/月", ["Pro 全部", "真人教练对接（R6）", "深度备赛报告", "优先支持"], TINT2, INK, false],
  ];
  tiers.forEach((t, i) => {
    const w = 3.85, x = M + i * (w + 0.29), y = 1.95, h = 3.75;
    card(s, x, y, w, h, t[3], t[4] === ACCENT);
    if (t[5]) s.addShape("rect", { x: x + w - 1.25, y: y + 0.28, w: 0.95, h: 0.4, fill: { color: ACCENT }, line: { type: "none" } });
    if (t[5]) T(s, "主力档", { x: x + w - 1.25, y: y + 0.28, w: 0.95, h: 0.4, fontSize: 11.5, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    T(s, t[0], { x: x + 0.32, y: y + 0.3, w: 2, h: 0.5, fontSize: 20, bold: true, color: t[4] });
    T(s, t[1], { x: x + 0.32, y: y + 0.86, w: w - 0.64, h: 0.75, fontSize: 34, bold: true, color: t[4] });
    T(s, i === 1 ? "年付 8 折 ≈ ¥278/年 ｜ 6 月付 9 折" : i === 2 ? "或赛季包，形态待验证" : "拉新 / 新手", {
      x: x + 0.32, y: y + 1.62, w: w - 0.64, h: 0.35, fontSize: 11.5, color: MUTED });
    T(s, t[2].map((l, j) => ({ text: l, options: { bullet: bu(), breakLine: j < t[2].length - 1 } })), {
      x: x + 0.32, y: y + 2.1, w: w - 0.6, h: 1.5, fontSize: 12.5, color: INK, paraSpaceAfter: 7, valign: "top" });
  });
  T(s, "付费钩子绑在高意图时刻：建赛季计划、深度诊断、比赛策略。对标：PaceMate 年卡 ¥349 ≈ ¥29/月 —— 价位带已被同类验证。", {
    x: M, y: 6.05, w: CW, h: 0.4, fontSize: 13, color: INK });
  footer(s, 10);
})();

// ---------- 11 单位经济（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "单位经济（Base case · 假设待校准）", "我们按最保守口径规划，不按乐观假设融资");
  const stats = [
    ["LTV", "≈ ¥215", "订阅 ¥130 + 导购 ¥85"],
    ["混合 CAC", "≈ ¥130", "免费获客 ¥10 · 纯投放口径 ¥200"],
    ["回本周期", "≈ 16 个月", "超 12 月健康线，待杠杆改善"],
    ["LTV / CAC", "1.7", "三杠杆推向 ≥ 3"],
  ];
  stats.forEach((t, i) => {
    const w = (CW - 3 * 0.3) / 4, x = M + i * (w + 0.3);
    card(s, x, 1.85, w, 1.42, i === 3 ? TINT : TINT2);
    T(s, t[0], { x: x + 0.25, y: 2.0, w: w - 0.5, h: 0.35, fontSize: 12.5, color: MUTED });
    T(s, t[1], { x: x + 0.25, y: 2.32, w: w - 0.5, h: 0.55, fontSize: 27, bold: true, color: i === 3 ? ACCENT : INK });
    T(s, t[2], { x: x + 0.25, y: 2.88, w: w - 0.5, h: 0.32, fontSize: 10.5, color: MUTED });
  });
  // 左：敏感性 bar chart
  T(s, "LTV/CAC 敏感性", { x: M, y: 3.62, w: 5.6, h: 0.38, fontSize: 15, bold: true, color: INK });
  s.addChart(p.charts.BAR, [{
    name: "LTV/CAC", labels: ["Bear（亏损）", "Base", "Bull（健康）"], values: [0.8, 1.7, 3.4],
  }], {
    x: M, y: 4.05, w: 5.6, h: 2.25, barDir: "col",
    chartColors: ["C9C9D1", ACCENT, "1D1D24"], varyColors: true,
    showValue: true, dataLabelPosition: "outEnd", dataLabelColor: INK, dataLabelFontSize: 12, dataLabelFontFace: YH, dataLabelFormatCode: "0.0",
    catAxisLabelColor: MUTED, catAxisLabelFontSize: 12, catAxisLabelFontFace: YH,
    valAxisHidden: true, valAxisMaxVal: 6, valGridLine: { style: "none" }, catGridLine: { style: "none" },
    showLegend: false, chartArea: { fill: { color: BG } },
  });
  T(s, "健康线 ≥ 3 ｜ Bear = churn 8% + 毛利 25% + CAC ¥200（无自然流量）", { x: M, y: 6.36, w: 5.9, h: 0.3, fontSize: 11.5, color: MUTED });
  // 右：三杠杆
  T(s, "三大杠杆：1.7 → ≥ 3", { x: 6.85, y: 3.62, w: 5.9, h: 0.38, fontSize: 15, bold: true, color: INK });
  const levers = [
    ["毛利率随规模回升", "研发前置固定成本被摊薄 + LLM 单位成本走低：30%→45% 时订阅 LTV ¥130→¥194（最大杠杆）"],
    ["压流失率", "churn 6%→4%：生命周期 16→25 个月，LTV +56%；主动教练 push 与周期化闭环为此设计"],
    ["自然流量 + 导购净增量", "手表导入冷启动 + 社区裂变压 CAC；R2–R4 对免费用户变现，是不增获客成本的 LTV 净增量"],
  ];
  levers.forEach((l, i) => {
    const y = 4.05 + i * 0.84;
    T(s, [
      { text: `0${i + 1}  `, options: { bold: true, color: ACCENT, fontSize: 14 } },
      { text: l[0], options: { bold: true, color: INK, fontSize: 13.5 } },
    ], { x: 6.85, y, w: 5.9, h: 0.36 });
    T(s, l[1], { x: 7.28, y: y + 0.34, w: 5.5, h: 0.5, fontSize: 11.5, color: MUTED, lineSpacingMultiple: 1.15 });
  });
  T(s, "口径：ARPU ¥27 · churn 6% · 毛利 30%（全负载）· 免费获客 ¥10 · 均为假设 ｜ 行为前提：跑步是跨赛季的长期习惯", {
    x: M, y: 6.68, w: CW, h: 0.3, fontSize: 12, color: MUTED });
  footer(s, 11);
})();

// ---------- 12 路线图（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "路线图：产品 × 商业化节奏", "每个阶段产品里程碑与商业化动作咬合（建议节奏，非承诺）");
  const ph = [
    ["P0", "统一对话入口", "意图识别路由；建/改计划、状态问答", "上线订阅墙 Free vs Pro"],
    ["P1", "训练核心补全", "挪课/跳课 · feedback · 改目标重排", "转化漏斗调优"],
    ["P2", "身体 & 安全", "伤病门控 · 重返跑步 · 睡眠/HRV 联动", "Elite 档 + 真人教练试点"],
    ["P3", "数据加持咨询", "营养 · 恢复 · 天气改课", "补给/恢复品导购接入"],
    ["P4", "外部世界", "比赛发现/策略 · 装备 · 后勤", "跑鞋+报名+酒店+品牌合作"],
    ["P5", "社区 & 数据", "社交扩展 · 知识库 · 聚合数据", "B2B 数据产品"],
  ];
  const w = (CW - 5 * 0.22) / 6;
  ph.forEach((c, i) => {
    const x = M + i * (w + 0.22), y = 2.0;
    s.addShape("ellipse", { x: x + w / 2 - 0.36, y, w: 0.72, h: 0.72, fill: { color: i === 0 ? ACCENT : BG_DARK }, line: { type: "none" } });
    T(s, c[0], { x: x + w / 2 - 0.36, y, w: 0.72, h: 0.72, fontSize: 15, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
    if (i < 5) s.addShape("line", { x: x + w / 2 + 0.42, y: y + 0.36, w: w + 0.22 - 0.84, h: 0, line: { color: "D9D9DE", width: 1.25, dashType: "dash" } });
    T(s, c[1], { x: x - 0.05, y: y + 0.92, w: w + 0.1, h: 0.4, fontSize: 13.5, bold: true, color: INK, align: "center" });
    card(s, x, 3.45, w, 2.5, TINT2);
    T(s, c[2], { x: x + 0.14, y: 3.62, w: w - 0.28, h: 1.05, fontSize: 11.5, color: INK, lineSpacingMultiple: 1.2, valign: "top" });
    s.addShape("line", { x: x + 0.14, y: 4.78, w: w - 0.28, h: 0, line: { color: "DDDDE2", width: 1 } });
    T(s, c[3], { x: x + 0.14, y: 4.9, w: w - 0.28, h: 0.95, fontSize: 11.5, bold: true, color: ACCENT, lineSpacingMultiple: 1.2, valign: "top" });
  });
  T(s, "当前所在：P0–P1 已在生产运行（教练对话、训练计划、比赛策略、多设备同步）", {
    x: M, y: 6.25, w: CW, h: 0.4, fontSize: 13, color: INK, bold: true });
  T(s, "商业化列（红字）为各阶段激活的收入流：R1 订阅 → R6 教练 → R2 导购 → R2/R3/R4/R5 → R7 数据", {
    x: M, y: 6.68, w: CW, h: 0.35, fontSize: 12, color: MUTED });
  footer(s, 12);
})();

// ---------- 13 团队与融资（浅） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG };
  header(s, "团队与融资", "互补双创始人：产品技术已上线生产 × 运动零售产业变现资源");
  // 左：团队（双创始人行式）
  card(s, M, 1.85, 5.9, 3.1, TINT2);
  T(s, "团队 · 产品自研 × 产业变现", { x: M + 0.32, y: 2.08, w: 5.3, h: 0.42, fontSize: 16, bold: true, color: INK });
  T(s, "赵超毅 · 创始人 ｜ 产品与技术 ｜ 全马 PB 2:57", { x: M + 0.32, y: 2.52, w: 5.3, h: 0.36, fontSize: 13, bold: true, color: ACCENT });
  T(s, "IBM 中国研究院 Research Scientist · 树根互联研发总监 · 微软亚太研发中心资深软件工程师；擅长大规模数据处理与分析，现主导产品设计与开发", {
    x: M + 0.32, y: 2.88, w: 5.26, h: 0.5, fontSize: 11, color: MUTED, lineSpacingMultiple: 1.15 });
  s.addShape("line", { x: M + 0.32, y: 3.46, w: 5.26, h: 0, line: { color: "E3E3E8", width: 1 } });
  T(s, "蒋振华 · 联合创始人 ｜ 市场与变现 ｜ 全马 PB 2:56", { x: M + 0.32, y: 3.58, w: 5.3, h: 0.36, fontSize: 13, bold: true, color: ACCENT });
  T(s, "胜道体育（YYSPORTS·宝胜国际体系）总监：运动零售品牌 / 渠道 / 供应链资源，直接支撑导购引擎 R2 与品牌合作 R5", {
    x: M + 0.32, y: 3.94, w: 5.26, h: 0.5, fontSize: 11, color: MUTED, lineSpacingMultiple: 1.15 });
  T(s, "双资深跑者 · 多年系统训练 —— 自己就是产品最苛刻的用户", {
    x: M + 0.32, y: 4.5, w: 5.26, h: 0.32, fontSize: 11.5, bold: true, color: ACCENT });
  // 右：融资
  card(s, 6.83, 1.85, 5.9, 3.1, TINT);
  T(s, "本轮融资：300 万元（轮次 / 估值待补）", { x: 7.15, y: 2.1, w: 5.3, h: 0.45, fontSize: 17, bold: true, color: ACCENT });
  T(s, "资金用途（按 18 个月里程碑规划）：", { x: 7.15, y: 2.6, w: 5.3, h: 0.38, fontSize: 12.5, color: INK });
  const uses = [["用户增长与市场开拓", 50], ["产品与算法研发", 35], ["数据与基础设施", 15]];
  uses.forEach((u, i) => {
    const y = 3.15 + i * 0.52, bw = 2.3;
    T(s, u[0], { x: 7.15, y, w: 1.95, h: 0.36, fontSize: 12, color: INK, valign: "middle" });
    s.addShape("roundRect", { x: 9.2, y: y + 0.06, w: bw, h: 0.24, fill: { color: "F3D9D7" }, line: { type: "none" }, rectRadius: 0.03 });
    s.addShape("roundRect", { x: 9.2, y: y + 0.06, w: bw * u[1] / 50, h: 0.24, fill: { color: ACCENT }, line: { type: "none" }, rectRadius: 0.03 });
    T(s, `${u[1]}%`, { x: 9.2 + bw + 0.12, y, w: 0.7, h: 0.36, fontSize: 12, bold: true, color: ACCENT, valign: "middle" });
  });
  // 底部：里程碑
  card(s, M, 5.25, CW, 1.32, BG_DARK);
  T(s, "本轮要验证的里程碑（对应单位经济三杠杆）", { x: M + 0.35, y: 5.45, w: 11, h: 0.4, fontSize: 14.5, bold: true, color: "FFFFFF" });
  T(s, "付费用户数与留存曲线（churn 6%→4% 路径）｜ Free→Pro 转化率 ≥5% ｜ 混合 CAC ≤ ¥130 ｜ 导购 GMV 起量", {
    x: M + 0.35, y: 5.9, w: 11.4, h: 0.5, fontSize: 13, color: "E8E8EE" });
  footer(s, 13);
})();

// ---------- 16 封底（深） ----------
(() => {
  const s = p.addSlide(); s.background = { color: BG_DARK };
  T(s, "让每一次训练，", { x: M, y: 1.85, w: CW, h: 0.95, fontSize: 44, bold: true, color: "FFFFFF" });
  T(s, "都有教练级的指导。", { x: M, y: 2.8, w: CW, h: 0.95, fontSize: 44, bold: true, color: ACCENT });
  s.addShape("line", { x: M + 0.04, y: 4.1, w: 3.2, h: 0, line: { color: "3A3A44", width: 1 } });
  T(s, "StrideWise ｜ 对话式 AI 跑步教练 ｜ 商业计划书 · 2026-10", { x: M, y: 4.35, w: CW, h: 0.4, fontSize: 15, color: W_MUTED });
  T(s, "赵超毅", { x: M, y: 5.15, w: 5, h: 0.4, fontSize: 15, bold: true, color: ACCENT });
  T(s, "stride@lipaotech.com", { x: M, y: 5.62, w: 6, h: 0.45, fontSize: 19, color: "FFFFFF" });
  T(s, "130 2322 7605", { x: M, y: 6.14, w: 6, h: 0.45, fontSize: 19, color: "FFFFFF" });
  T(s, "机密，仅供指定投资人评估", { x: M, y: 6.95, w: CW, h: 0.35, fontSize: 12, color: W_MUTED });
})();

p.writeFile({ fileName: "/Users/zhaochaoyi/workspace/stride/running/spec/STRIDE_COACH_BP_DECK.pptx" })
  .then(() => console.log("OK: StrideWise_COACH_BP_DECK.pptx"));
