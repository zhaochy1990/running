# WeChat Mini Program (STRIDE 微信小程序)

本目录是 STRIDE 微信小程序的独立前端工程，使用原生小程序框架 + TypeScript 开发。

> 父级仓库的 `CLAUDE.md` 仍为最高准则；本文件仅补充小程序专属规则。如有冲突，以父级为准。

---

## 目录结构

```
src/wechat-miniprogram/
├── project.config.json          # 微信开发者工具项目配置
├── project.private.config.json  # 个人配置（gitignore）
├── sitemap.json                 # 小程序搜索索引配置
├── tsconfig.json                # TypeScript 配置
├── typings/                     # 小程序类型声明补充
│
├── app.ts                       # 小程序入口
├── app.json                     # 全局配置（页面路由、tabBar、窗口样式）
├── app.wxss                     # 全局样式
│
├── pages/                       # 页面（每页面四件套：.ts / .wxml / .wxss / .json）
│   ├── index/                   # 首页 —— 今日训练 + 状态概览
│   ├── plan/                    # 周训练计划
│   ├── activities/              # 活动列表
│   ├── activity-detail/         # 活动详情
│   ├── health/                  # 健康 & 疲劳趋势
│   ├── coach/                   # Coach 问答
│   └── profile/                 # 个人中心
│
├── components/                  # 可复用组件
│   ├── ui/                      # 基础 UI 组件
│   ├── training/                # 训练相关组件
│   └── activity/                # 活动相关组件
│
├── services/                    # API 服务层
│   ├── request.ts               # wx.request 封装（拦截器、错误处理、token）
│   ├── auth.ts                  # 微信登录 + 后端 token 交换
│   ├── activities.ts
│   ├── plan.ts
│   ├── health.ts
│   ├── coach.ts
│   └── user.ts
│
├── store/                       # 状态管理
│   ├── index.ts                 # 全局 store（基于 globalData + 订阅）
│   ├── user.ts
│   └── training.ts
│
├── utils/                       # 工具函数
│   ├── format.ts                # 配速、时间、距离格式化
│   ├── date.ts                  # 日期处理（上海时区）
│   ├── unit.ts                  # 单位换算
│   └── validate.ts              # 表单校验
│
├── types/                       # 共享类型定义
│   ├── api.ts
│   ├── activity.ts
│   ├── plan.ts
│   ├── health.ts
│   └── user.ts
│
├── constants/                   # 常量配置
│   ├── config.ts                # 环境配置（API base URL 等）
│   └── zones.ts                 # 心率区 / 配速区定义
│
├── assets/                      # 静态资源
│   ├── images/
│   └── icons/
│
└── styles/                      # 样式抽离
    ├── variables.wxss           # CSS 变量 / 设计令牌
    └── mixins.wxss              # 可复用样式片段
```

---

## 开发规范

### 技术栈

- **原生微信小程序**（不使用 Taro / uni-app 等跨端框架）
- **TypeScript** —— 与项目整体 TS 生态一致
- **微信开发者工具** 直接编译，构建链路最简

### 命名约定

| 类别 | 规则 | 示例 |
|------|------|------|
| 页面目录 | kebab-case | `activity-detail/` |
| 组件目录 | kebab-case | `stat-card/` |
| 文件名（页面/组件四件套） | 与目录同名 | `index.ts` / `index.wxml` / `index.wxss` / `index.json` |
| 工具 / 服务 / 类型文件 | kebab-case | `format.ts` / `request.ts` |
| TypeScript 类型 | PascalCase | `Activity`, `WeeklyPlan` |
| 函数 / 变量 | camelCase | `formatPace()`, `weeklyDose` |
| 常量 | UPPER_SNAKE_CASE | `MAX_DOSE_PER_DAY` |
| 事件处理函数 | `on` / `handle` 前缀 | `onTapPlan()`, `handleScroll()` |

### 页面与组件约定

- 页面 `Page()` 调用放在 `.ts` 文件末尾，类/逻辑写在前面
- 自定义组件 `Component()` 调用同理
- 所有 `.ts` 文件必须带类型，禁止 `any`（特殊情况加 `// eslint-disable-next-line` 并写理由）
- `data` 字段的类型通过 `interface PageData` 显式声明，再用 `Page<PageData>()` 绑定

### 样式约定

- 使用 **rpx** 作为响应式尺寸单位（宽度方向）
- 颜色、间距、圆角统一走 `styles/variables.wxss` 中的 CSS 变量
- 避免内联样式；动态样式优先通过 class 切换
- 与 Web 端 `frontend/` 保持视觉一致（间距、色板、字体层级），但不共享代码

---

## API 与数据层

### `services/request.ts` — 统一请求封装

- 基于 `wx.request`，提供 `get / post / patch / put / del` 方法
- **请求拦截**：自动注入 `Authorization: Bearer <token>`
- **响应拦截**：
  - 200 走 resolve；业务错误码统一走 reject 并 `wx.showToast`
  - 401 自动触发重新登录流程
  - 网络错误 / 超时友好提示
- baseURL 从 `constants/config.ts` 读取，支持 dev / prod 环境切换

### 认证流程

1. 启动时调用 `wx.login()` 获取 `code`
2. 调用后端 `/api/auth/wechat-login` 换 JWT
3. JWT 存入 `wx.setStorageSync('token', ...)`
4. 后续请求自动带 token

**后端依赖（auth-service）**：

| 端点 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `POST /api/auth/wechat-login` | `{ code }` | `{ access_token, refresh_token, expires_in, user, needs_binding }` | 微信 code 登录；`needs_binding=true` 表示该微信未绑定任何账号，需跳绑定页 |
| `POST /api/auth/wechat-bind` | `{ code, email, password }` | 同上 | 将微信绑定到已有 STRIDE 账号，绑定成功后直接登录 |

这两个端点目前**尚未在 auth-service 实现**，需要单独开后端任务。auth-service 在数据库层需要为 user 增加 `wechat_openid` / `wechat_unionid` 字段。BFF 层 `/api/auth/*` 已统一代理到 auth 上游，小程序请求直接走同样的路由即可，不需要改 BFF。

> 后端未就绪时的临时开发方案：把 Web 端登录拿到的 token 手动 `wx.setStorageSync('token', ...)` 注入，绕过微信登录流程。

### 类型共享

- API 请求/响应类型与 Web 端 `frontend/src/types/` 保持契约一致
- 初期手动维护对齐；后续考虑抽到独立 npm 包或通过 OpenAPI 代码生成

---

## 时区规则（HARD，与主仓库一致）

所有面向用户的日 / 周分类使用 **Asia/Shanghai (UTC+8, 无 DST)**。

- 日期处理统一走 `utils/date.ts`
- 禁止 `new Date().getFullYear()`、`Date.now()` 等本地时间假设
- 服务器返回的 UTC ISO 时间戳 → 展示前必须转上海时区

---

## 开发环境

### 本地开发

1. 打开微信开发者工具
2. 导入项目 → 选择本目录
3. AppID 使用测试号或公司主体
4. 后端 API 地址在 `constants/config.ts` 中切换（或通过 `project.private.config.json` 的 env 注入）

### 与现有后端对接

- 小程序复用现有 `stride-app`（Python FastAPI）+ `stride api`（Go）的同一套 REST API
- 鉴权走微信 `code2session` 换 JWT 的新端点
- API 路径前缀与 Web 端一致：`/api/...`

---

## 不做什么

- 不引入状态管理库（如 MobX / Redux 等），`globalData` + 自定义订阅足够
- 不做跨端兼容（只服务微信小程序）
- 不直接读写 `coros.db` 或本地 SQLite，数据全部走后端 API
- 不把小程序代码放进 `frontend/` 目录，它是独立工程
