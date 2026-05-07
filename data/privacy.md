# STRIDE 隐私政策

**最后更新：2026-05-07**

STRIDE 是个人开发的跑步训练工具。本文档说明我们收集什么数据、为什么收集、
存放在哪里、以及你如何删除自己的数据。任何疑问都可以发邮件到
**zhaochaoyi@microsoft.com**。

---

## 1. 我们收集什么

STRIDE 只在你**主动登录、主动同步、或主动操作**之后才收集数据：

### 1.1 你主动提供
- **账户信息**：邮箱、密码（哈希后存储）。
- **个人资料**：昵称、性别、出生日期、马拉松目标成绩（可选）。
- **InBody 体测数据**：你手动上传时记录的体重、体脂、肌肉量等。
- **训练反馈**：你在 COROS App 写的训练后备注（`sport_note`）。

### 1.2 同步自佳明 / 高驰
- **跑步活动**：距离、时长、配速、心率、海拔、步频、GPS 轨迹（如有）。
- **每日健康**：静息心率、HRV、疲劳度、训练负荷、睡眠总长。

> 注意：我们**不会**主动从你的手表或手机读取数据。所有同步都通过你
> 已授权的 COROS Training Hub / Garmin Connect 接口发起。

### 1.3 设备 & 推送
- **JPush 注册 ID**（推送）：一段不可识别个人身份的字符串，仅用于把通知
  发送到你的设备。我们不向 JPush 上传你的姓名、邮箱、活动数据。
- **应用版本号**、**Android 平台标识**：用于排错。

我们**不**收集：通讯录、相册、定位（除非 COROS GPS 轨迹同步）、设备 IMEI、
通话记录、其它 App 的使用数据。

---

## 2. 数据存放在哪里

- 账户与训练数据托管在 **Microsoft Azure（中国东南亚区域）** 的容器服务和
  Azure Files 存储。
- 推送通过 **极光推送（北京极光）** 发出。
- 不向上述以外的第三方分享。

---

## 3. 数据用途

| 用途 | 数据 |
|------|------|
| 显示你的训练数据 | 跑步活动、日常健康、计划 |
| 教练点评生成 | Azure OpenAI 服务（`gpt-4.1`）；输入是你的活动数据和过往周计划 |
| 推送通知 | JPush 注册 ID（点赞 + 训练日提醒，按你的设置） |
| 计算训练负荷 / 比赛预测 | 跑步活动、心率区间 |

我们**不会**把你的数据用于广告、不会卖给第三方、不会用于跨用户画像。
教练点评的 LLM 推理是**单次请求**，输入数据不会被 OpenAI 用于模型训练
（详见 [Azure OpenAI 数据隐私](https://learn.microsoft.com/azure/ai-services/openai/concepts/legal-and-privacy)）。

---

## 4. 推送通知

STRIDE 提供两类通知，**默认开启**，可在 App 内或系统设置中关闭：

1. **点赞提醒** — 队友给你的训练点赞时收到。
2. **训练日提醒** — 早上 8 点推送当天计划。

通知内容**仅包含动作类型 + 训练摘要**（如「今日 12km」），不包含你的
身份证号、邮箱、地理位置等敏感字段。

---

## 5. 你的权利

- **查看**：登录 STRIDE 即可查看所有同步数据；写信给上面邮箱可索取
  导出文件。
- **修改**：在 App 或网页端编辑个人资料、关闭同步、撤回同步授权
  （从 COROS 或 Garmin 一侧）。
- **删除账户**：发邮件到 **zhaochaoyi@microsoft.com**，主题 `delete account`，
  我们将在 7 个工作日内删除你账户下所有数据，包括：
  - SQLite 数据库中的活动 / 健康 / 计划 / 反馈记录
  - JPush 注册 ID
  - Azure Files 上的训练日志 markdown
  - 教练点评草稿

---

## 6. 数据安全

- 与服务器之间所有通信走 HTTPS。
- 密码使用 RS256 JWT + bcrypt 哈希存储。
- Azure Files / Azure Storage 启用静态加密（AES-256）。
- 极光 Master Secret 等密钥仅存放在 Azure Key Vault，不进入代码或日志。

我们尽力但不能保证 100% 不被攻破。如果发生泄露，我们会在 72 小时内通过
邮件 + App 内通知告知你。

---

## 7. 第三方服务

| 服务 | 用途 | 隐私政策 |
|------|------|----------|
| Microsoft Azure | 数据托管 | [microsoft.com/privacy](https://www.microsoft.com/privacy) |
| 高驰 / COROS | 跑步数据来源（你已授权） | [coros.com/privacy](https://www.coros.com/privacy.php) |
| Garmin | 跑步数据来源（你已授权） | [garmin.com/privacy](https://www.garmin.com.cn/legal/privacy-policy/) |
| Azure OpenAI | 教练点评生成 | [Microsoft 数据保护补充条款](https://learn.microsoft.com/azure/ai-services/openai/concepts/legal-and-privacy) |
| 极光推送 (JPush) | 推送通道 | [jiguang.cn/license/privacy](https://www.jiguang.cn/license/privacy) |

---

## 8. 未成年人

STRIDE 不面向 14 岁以下用户。如果你发现有 14 岁以下用户注册，请发邮件
通知，我们会立即删除其账户。

---

## 9. 政策更新

本政策有重大变化时，我们会通过 App 内顶部横幅通知。继续使用即表示你
接受新版本。

---

**联系方式**：zhaochaoyi@microsoft.com
**主体**：个人独立开发（非企业），项目仓库 `running`
**域名**：`stride-running.cn`（备案中）
