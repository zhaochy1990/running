# 中国大陆支付接入调研 + 大陆企业主体接入方案

> 状态：**调研存档，未开工**。后续真正要做支付时从这里继续。
> 场景：STRIDE 付费会员，多端（PC 网页 + H5 + 未来原生 App）+ 订阅自动续费。
> 调研日期：2026-06。费率/准入条件以官方最新报价为准。

---

## 0. 核心结论（最重要的一条）

> **"支付宝/微信 + 自动续费（周期扣款）" 几乎只能由中国大陆企业主体拿到。**
> 跨境通道（Stripe / Airwallex / PingPong）的支付宝、微信支付**全部是单次付款，不支持自动续费订阅**。

推论：既然 STRIDE 要做订阅自动续费，**主体被锁定为大陆企业主体**（营业执照 + 对公账户）。
微软海外实体 / 个人都拿不到支付宝、微信的自动续费能力。

例外：若可接受"订阅扣款走国际信用卡(Visa/Master)、支付宝/微信只做单次买断"，才轮得到跨境/海外主体。

---

## 1. 三条主体路径对比

| 维度 | ① 大陆企业直连官方（选定路径） | ② 大陆主体走聚合(Ping++等) | ③ 海外主体走跨境(Stripe/Airwallex) |
|---|---|---|---|
| 谁能用 | 营业执照+对公账户的大陆公司 | 同上/轻度挂靠 | 海外公司（含港新实体）；海外个人 Stripe 部分可 |
| 支付宝/微信 单次 | ✅ | ✅ | ✅ |
| 支付宝/微信 自动续费 | ✅ 可申请（有门槛，见 §3） | ⚠️ 取决聚合方，多数有限 | ❌ 不支持 |
| 结算 | 人民币 T+1 对公账户 | 人民币 | 外币结算，需购汇/提现 |
| 费率(线上会员类) | 官方标准约 **0.6%** | 官方费率+加点 | 约 **2.5%–3%+** + 汇损 |
| 合规 | ICP 备案、行业资质、对公开户 | 聚合方分担部分 | 海外 KYB/KYC |

**结论：选路径①（大陆企业主体直连）。** 唯一能干净拿到支付宝/微信自动续费的路。

---

## 2. 多端接入映射

同一商户号下按端选产品，不能混用：

| 端 | 支付宝产品 | 微信支付产品 |
|---|---|---|
| PC 网页 | 电脑网站支付 | Native 扫码支付 |
| 手机网页 H5（浏览器） | 手机网站支付(wap) | H5 支付 |
| 微信内打开的网页 | （无此问题） | **必须 JSAPI**（需服务号 openid，微信内拦截 H5） |
| 原生 App | App 支付(SDK) | App 支付(SDK) |
| 自动续费签约 | 周期扣款签约页 | 委托代扣预签约 |

⚠️ 微信 H5 在微信浏览器内被拦截 → 需 JSAPI → 需提前规划服务号主体。

---

## 3. 订阅自动续费的真实门槛（第二期才上）

**不是开通即用**，有前置审核：

### 微信「自动续费（原委托代扣 / papay）」
- 主体限制：仅 企业/政府/事业单位/社会组织。
- 流量门槛：近 4 自然周 有效订单去重用户 **> 300 人** 且 投诉率 **≤ 0.05%**。
- 行业准入：在线会员（音视频/阅读/游戏等）、公共缴费、政务。运动健身会员归"在线会员"，大概率可申请。
- 费率限制：必须标准费率商户。

### 支付宝「周期扣款 / 免密代扣」
- 企业主体 + 单独签约申请 + 风控审核。
- 扣款前需与用户**显式签约**、展示周期与金额、提供随时可查/可取消入口（2025 监管收紧 UI 合规）。
- 门槛比微信宽，通常先拿到的一条。

**关键推论：冷启动拿不到微信自动续费（无 300 付费用户历史）。**
→ 第一期必须先用"单次付款"跑起来攒流量，再申请自动续费。这决定了上线顺序。

---

## 4. 大陆企业主体接入方案（简版）

### 4.1 前置准备（一次性）

| 项 | 内容 |
|---|---|
| 主体 | 营业执照 + 对公账户 |
| 支付宝 | 开放平台建应用 → `app_id` + 应用公钥上传/下载支付宝公钥 |
| 微信 | 商户平台开户 → `mch_id` + APIv3 密钥 + 商户证书；微信内场景再注册服务号拿 `appid` |
| 域名 | ICP 备案 + HTTPS 回调公网可达 |

### 4.2 架构

> 前端只负责 请求下单 + 展示二维码/跳转 + 轮询订单状态；
> 所有签名/验签/扣款/对账在 FastAPI 后端；密钥在 Key Vault，订单在 Table Storage。

```
React (Vite)
   │  POST /api/pay/create   ─────►  FastAPI
   │  ◄── 二维码URL / 跳转link       ├─ 统一下单(支付宝/微信SDK)
   │  GET  /api/pay/status            ├─ 私钥 ← Azure Key Vault
   │                                   └─ 订单 → Azure Table Storage
支付宝/微信 ──回调──► /api/pay/callback/{provider}  (验签+幂等+置状态)
```

### 4.3 后端端点（4 个）

| 端点 | 作用 |
|---|---|
| `POST /api/pay/create` | 入参 `{plan, channel}`；生成 `out_trade_no`，调统一下单，返回二维码/跳转 |
| `GET /api/pay/status` | 前端轮询订单状态 `PENDING/PAID/FAILED/CLOSED` |
| `POST /api/pay/callback/alipay` | 支付宝异步回调：验签→幂等→标记 PAID→发货 |
| `POST /api/pay/callback/wechat` | 微信 V3 回调：验签解密→幂等→标记 PAID→发货 |

`create` 内按 `channel` 分支选产品（PC=电脑网站/Native，H5=wap/H5支付，微信内=JSAPI）。

### 4.4 订单状态机（幂等核心）

```
CREATE → PENDING ──回调PAID──► PAID → (发货:开通会员)
            │
            └──超时/查单CLOSED──► CLOSED
```

- `out_trade_no` 全局唯一，回调按它幂等；已 PAID 的重复回调直接返回 success，不重复发货。
- 回调只信验签后的金额，与本地订单金额比对一致才发货。
- 兜底：定时主动**查单**补偿，防回调丢失，别只依赖回调。

### 4.5 数据落地（守仓库硬规则）

- ❌ **不进** `coros.db`（不是手表 sync 数据，违反 Storage scope rule）。
- ✅ 订单/会员状态 → **Azure Table Storage**，复用 `src/stride_server/likes_store.py` 的 two-backend + `DefaultAzureCredential` pattern。
  - `payments` 表：PK=`user_id`，RK=`out_trade_no`，字段 `channel/amount_fen/status/paid_at`（时间 UTC ISO 8601）。
  - `entitlements` 表：PK=`user_id`，RK=`"membership"`，字段 `active/expire_at`（UTC ISO 8601 存，上海展示）。

### 4.6 密钥（守 secret 规则）

全部进 **Azure Key Vault**，运行时 `DefaultAzureCredential` 拉取，绝不进代码/SQLite/env 明文：
支付宝应用私钥、支付宝公钥、微信 APIv3 密钥、微信商户证书私钥。

### 4.7 踩坑清单

- 金额单位：**微信用「分」、支付宝用「元」**，create 时转换别错。
- 时间：UTC 存、上海展示（沿用 `src/stride_core/timefmt.py` / `frontend/src/lib/shanghai.ts`）。
- `stride-app` 单副本 → 回调和查单都要幂等，状态置位用条件更新（乐观锁）防并发双发货。
- 回调地址在 Container App ingress 放行，HTTPS。

### 4.8 依赖

- `alipay-sdk-python`（官方）
- `wechatpayv3`（微信 V3，社区维护）

---

## 5. 落地路线图（分两期，绕开冷启动门槛）

**第一期：一次性付费买断**
1. Key Vault 放密钥 + Table Storage 建表
2. `create` + `status` + 两个 `callback`（先 PC 扫码，最简）
3. 发货逻辑（写 entitlements + 前端会员态）
4. 查单兜底定时任务
5. 加 H5 / 微信 JSAPI

**第二期：自动续费订阅**（攒够流量、满足准入后）
6. 支付宝周期扣款（门槛低先上）
7. 微信委托代扣
8. 配套：微信服务号主体（微信内 JSAPI）、原生 App 支付（若 App 上线）

---

## 6. 待决问题（开工前拍板）

1. 大陆企业主体能否落实？（自动续费总开关）
2. 订阅是否接受"先单次、后续费"两期上线？（微信 300 付费用户门槛绕不过）
3. 用户是否大量从微信内点进来？（是 → 提前规划服务号 JSAPI）

---

## 来源

- [Stripe — Alipay payments（单次，recurring 限制）](https://docs.stripe.com/payments/alipay)
- [Stripe — WeChat Pay payments](https://docs.stripe.com/payments/wechat-pay)
- [GitHub issue — Stripe 不支持支付宝/微信订阅](https://github.com/nearai/chat-api/issues/276)
- [微信支付 — 自动续费（原委托代扣）商户自助申请指引](https://developers.weixin.qq.com/community/pay/article/doc/0004c22aed8588ca99b3c846866413)
- [微信支付 — 委托扣款模式 产品文档 V2](https://pay.weixin.qq.com/doc/v2/merchant/4012205799)
- [一文说清"免密支付"和"自动续费" — 移动支付网](https://m.mpaypass.com.cn/news/202511/05090059.html)
- [Airwallex — How to Accept Alipay Payments](https://www.airwallex.com/uk/blog/how-to-accept-alipay-payments-the-definitive-guide)
