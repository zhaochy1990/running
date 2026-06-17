# STRIDE Landing Page + 登录 Modal — 设计文档

**日期**: 2026-06-17
**分支**: `feat/landing-page`(worktree,基于 `origin/master`)
**设计稿**: `spec/stride-landing.html`(单文件,含落地页 + 内联登录 overlay)

## 目标

把营销落地页接入 React 前端,作为**未登录访客**的公开入口;同时用设计稿里的登录
overlay modal 替换现有独立 `/login` 页面,登录逻辑接现有 `authStore`。

## 范围内 / 范围外

**范围内**
- 公开 `LandingPage`(hero / 倒推 26 周计划 / 三维训练 / 引擎特性 / 数据展示 / closer / footer)
- 登录 `LoginModal`(替换旧 `LoginPage.tsx`),接真实 `authStore.login()`
- 路由改造:`/` 公开=landing、登录后=dashboard
- 三个字体(Outfit / JetBrains Mono / Newsreader)self-host woff2
- 单元测试 + 本地浏览器 smoke

**范围外(明确不做)**
- Google / Strava OAuth 真实接入(后端无支持 → 按钮隐藏)
- 忘记密码 / 密码重置流程(后端无支持 → 入口隐藏)
- 落地页 footer 里的占位链接(订阅方案、帮助中心等)接真实页面
- 落地页 demo 数据接真实 API(hero 卡片 / 数据展示用静态 marketing 数据)

## 架构与路由

改 `frontend/src/App.tsx` 顶层,用 `AppOrLanding` 网关替换现有 `/*` ProtectedRoute 块:

```
<Routes>
  <Route path="/login"    element={<LoginEntry />} />      // 见下
  <Route path="/register" element={<RegisterPage />} />     // 不变
  <Route path="/onboarding" element={<ProtectedRoute><OnboardingWizard/></ProtectedRoute>} />
  <Route path="/*" element={<AppOrLanding />} />
</Routes>
```

- `AppOrLanding`:
  - **未登录** → 内嵌 `<Routes>`:`/` = `LandingPage`;`*` = `Navigate to="/login"`。
  - **已登录** → 现有 `OnboardingGate → UserProvider → AppLayout` dashboard 树(`/` = WeekLayout,
    其余路由 `/week/:folder`、`/activity/:id`、`/plan` 等**原样不动**)。
- `LoginEntry`(`/login` 元素):
  - 已登录 → `Navigate to="/"`。
  - 未登录 → `<LandingPage initialLoginOpen />`(渲染落地页并自动打开登录 modal)。
- 取舍:dashboard 全部保持挂在 `/` 下,**不挪到 `/app`**,避免改动所有内部链接。

**为什么 `/login` 仍保留路由**:现有 `ProtectedRoute` 在未登录时重定向 `/login`;外部深链、
以及 Playwright smoke 脚本(`page.goto('/login')`)都依赖它。保留 `/login` → landing+modal
让这些行为零破坏。

## 组件拆分

```
frontend/src/pages/landing/
  LandingPage.tsx        // 组合各 section + 控制 loginOpen 状态;接受 initialLoginOpen prop
  LandingNav.tsx         // sticky 顶部导航;登录/开始训练 → setLoginOpen(true)
  sections/
    Hero.tsx             // 含 hero 设备卡片(静态 demo 数据 + count-up 动画)
    ReversePlan.tsx      // 26 周周量曲线(phase 着色 + 揭示动画)
    Pillars.tsx          // 跑步/力量/饮食 三柱 + synthesis 等式
    Features.tsx         // 每日自适应 / AI 教练 / 成果分析
    DataShowcase.tsx     // 周里程 bars / 配速曲线 / 负荷环 / 分段表
    Closer.tsx           // CTA
    LandingFooter.tsx
  LoginModal.tsx         // 登录弹窗,接 authStore.login()
  useReveal.ts           // IntersectionObserver 滚动揭示 hook(替代设计稿的全局 IO 脚本)
  landing.css            // 从设计稿 <style> 移植
```

**CSS scope(关键)**:设计稿大量用裸标签选择器(`body` / `section` / `footer`)和全局类。
SPA 里全局引入会污染 dashboard。因此 `landing.css` 的每条规则都 scope 到 `.landing-root`
包裹层(`LandingPage` 最外层 div),例如 `.landing-root section{...}`、`.landing-root footer{...}`。
登录 modal 的 `#loginOverlay` / `.lg-*` 选择器本就是 ID 前缀,天然安全,沿用。

**动画移植**:设计稿用裸 DOM + IntersectionObserver。React 化为:
- `useReveal()` hook:对 ref 元素挂 IntersectionObserver,进入视口加 `.in` 类。
- count-up:`useCountUp(target)` 用 `requestAnimationFrame`,在揭示时触发。
- SVG draw / bar grow:用 CSS keyframes + 揭示类触发(同设计稿)。
- 周量曲线 / 周里程 bars / 负荷环的数据:作为组件内常量数组渲染(非 `innerHTML` 拼接)。

## 登录 Modal 接线

- 表单字段:邮箱(`type="email"`)、密码(`type="password"`);提交按钮文案 **"登录"**
  (保持与 smoke 脚本 `getByRole('button',{name:/^登录$/})` 兼容)。
- 提交 → `await authStore.login(email, password)`:
  - 复用现有逻辑:dev 经 Vite `/api/auth/*` 代理、token 持久化、401 处理。
  - **不**使用设计稿里的假跳 `index.html`。
- 成功 → `navigate('/')`(已登录态下 `/` 渲染 dashboard)。
- 错误态文案复用旧 `LoginPage`:
  - 401 → "邮箱或密码错误"
  - `user_disabled` → "账号已被禁用"
  - 其它 → "登录失败,请重试"
  - loading 时按钮显示"登录中…"并 disable。
- **隐藏**:Google / Strava OAuth 按钮 + 其上"或使用邮箱"分割线;"忘记密码?"链接。
- "创建训练档案 →" → `<Link to="/register">`。
- 关闭:点遮罩 / 关闭按钮 / Esc;但从 `/login` 进入(`initialLoginOpen`)且未登录时,
  关闭后回到落地页本身(modal 关,停留 `/`/landing)。

**旧 `LoginPage.tsx` 删除**:登录逻辑全部迁入 `LoginModal`,删除 `pages/LoginPage.tsx` 及其
在 `App.tsx` 的 import / route,避免两份登录 UI 并存(CLAUDE.md「不要重复造轮子」)。

## 字体(self-host)

- self-host 三个开源字体(均 OFL)到 `frontend/public/fonts/`,经 `@font-face` 引入,
  **不依赖** `fonts.googleapis.com`(国内常被墙 / 极慢;项目面向中国市场)。
  - Outfit(display):300–800
  - JetBrains Mono(mono):400–600
  - Newsreader(editorial / italic):400–600 + italic
- `@font-face` 放在 `landing.css`(或新 `fonts.css`),`font-display: swap`。
- 字体栈兜底沿用设计稿(`PingFang SC` / `system-ui` 等),woff2 缺失时不崩。
- woff2 文件实现期从 Google Fonts gstatic 拉取并落库到 `public/fonts/`。

## 测试与验证

**单元测试(vitest + RTL)**
- `AppOrLanding` 路由网关:未登录 `/` 渲染 landing;未登录 `/activities` 重定向 `/login`;
  已登录 `/` 渲染 dashboard(mock `authStore`)。
- `LoginModal`:填邮箱/密码 → 提交调用 `authStore.login`;成功后 `navigate('/')`;
  401 显示"邮箱或密码错误"。
- `LandingPage`:`initialLoginOpen` 为真时 modal 渲染、可见登录表单。

**本地浏览器 smoke(HARD,CLAUDE.md 强制)**
- 改动触及页面 / 路由 / auth → 必须跑 `cd frontend && npm run dev:frontend:local` + `npm run smoke:local`。
- 预期现有 `scripts/local-smoke.cjs` 基本通过(它 `goto('/login')` → 填 email/password →
  点"登录" → 等离开 `/login`,与新 modal 兼容)。
- 若 modal 自动打开时机 / 选择器有出入,同步微调 `local-smoke.cjs`(允许的小改)。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| `landing.css` 裸标签选择器污染 dashboard | 全部 scope 到 `.landing-root`;实现后切到 dashboard 目视确认无样式漂移 |
| 改 `App.tsx` 路由破坏现有受保护路由 / onboarding gate | 单测覆盖网关;smoke 验证登录后能进 dashboard |
| 新 modal 破坏 Playwright smoke | 保持 `type="email"` / `type="password"` / "登录"按钮;`/login` 自动开 modal |
| self-host 字体拉取失败 / 体积 | display=swap + 系统兜底;只取必要字重 |
| worktree 基于 origin/master,缺少设计稿文件 | 设计稿内容已在上下文;实现时按内容移植,无需文件 |
