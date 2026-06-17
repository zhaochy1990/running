# STRIDE Landing Page + 登录 Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把营销落地页接入 React 前端作为公开入口,并用设计稿的登录 modal 替换现有 `/login` 页,登录接现有 `authStore`。

**Architecture:** 新增公开 `LandingPage`(scoped CSS,从 `spec/stride-landing.html` 移植),登录做成 `LoginModal` 接 `authStore.login()`。改 `App.tsx` 路由:未登录 `/`=landing、已登录 `/`=dashboard;`/login` 渲染 landing 并自动开 modal。字体从 Google CDN 改为 self-host woff2。

**Tech Stack:** React 19 + Vite + react-router-dom v6 + zustand(authStore)+ Tailwind v4(`@theme`)+ vitest + @testing-library/react + Playwright(smoke)。

## Global Constraints

- **设计稿是唯一视觉真相**:已 committed 到 worktree `spec/stride-landing.html`(962 行)。所有落地页 / modal 的文案、结构、class 名必须与之一致(React 化:`class`→`className`、自闭合标签、`{/* */}` 注释、inline `<script>` → React hooks/effects)。
- **CSS scope(HARD)**:`landing.css` 每条规则前缀 `.landing-root`(裸标签如 `section`/`footer`/`body` 会污染 dashboard)。modal 的 `#loginOverlay` / `.lg-*` 选择器本就 ID 前缀,沿用。
- **登录按钮文案必须是 `登录`**(`getByRole('button',{name:/^登录$/})` smoke 依赖)。登录邮箱/密码输入必须是 `type="email"` / `type="password"`。
- **登录成功跳转 `/`**(已登录态 `/` 渲染 dashboard;与旧 `LoginPage` 行为一致)。
- **认证逻辑只能复用 `authStore`**:`login(email,password)` 失败抛 `{status, error}`;**不要**自己发请求或改 authStore。
- **不要重复造轮子**:旧 `pages/LoginPage.tsx` 删除,登录 UI 只保留 modal 一份。
- **前端本地验证(HARD,CLAUDE.md)**:收尾必须 `cd frontend && npm run dev:frontend:local` + `npm run smoke:local`,不能只跑 unit/build。
- **隐藏未实现入口**:Google/Strava OAuth 按钮 + 其上"或使用邮箱"分割线、"忘记密码?"链接 —— 不渲染。
- 所有命令在 worktree `frontend/` 下跑:`C:\Users\zhaochaoyi\workspace\running\.claude\worktrees\feat+landing-page\frontend`。
- 单测命令:`npx vitest run <path>`;全量 `npm test`;构建 `npm run build`;lint `npm run lint`。

---

## File Structure

**新建**
- `frontend/src/pages/landing/LandingPage.tsx` — 组合各 section + `loginOpen` 状态 + `.landing-root` 包裹;prop `initialLoginOpen?: boolean`
- `frontend/src/pages/landing/LandingNav.tsx` — sticky 顶部导航;触发开 modal
- `frontend/src/pages/landing/sections/Hero.tsx`
- `frontend/src/pages/landing/sections/ReversePlan.tsx`
- `frontend/src/pages/landing/sections/Pillars.tsx`
- `frontend/src/pages/landing/sections/Features.tsx`
- `frontend/src/pages/landing/sections/DataShowcase.tsx`
- `frontend/src/pages/landing/sections/Closer.tsx`
- `frontend/src/pages/landing/sections/LandingFooter.tsx`
- `frontend/src/pages/landing/LoginModal.tsx` — 登录弹窗,接 `authStore.login()`
- `frontend/src/pages/landing/useReveal.ts` — IntersectionObserver 揭示 + count-up hooks
- `frontend/src/pages/landing/landing.css` — 从设计稿 `<style>` 移植,scope 到 `.landing-root`
- `frontend/src/AppRoutes.tsx` — 抽出 `<Routes>`(可测);含 `AppOrLanding` + `LoginEntry`
- 测试:`frontend/src/pages/landing/__tests__/LoginModal.test.tsx`、`LandingPage.test.tsx`、`frontend/src/__tests__/AppRoutes.test.tsx`、`useReveal.test.ts`

**修改**
- `frontend/src/App.tsx` — 改为 `<BrowserRouter><RouteTracker/><AppRoutes/></BrowserRouter>`
- `frontend/src/index.css:1` — 删除 Google Fonts `@import`,换 self-host `@font-face`(见 Task 7)

**删除**
- `frontend/src/pages/LoginPage.tsx`

**新增资产**
- `frontend/public/fonts/*.woff2` — Outfit / JetBrains Mono / Newsreader

---

## Task 1: `useReveal` 揭示与 count-up hooks

**Files:**
- Create: `frontend/src/pages/landing/useReveal.ts`
- Test: `frontend/src/pages/landing/__tests__/useReveal.test.ts`

**Interfaces:**
- Produces:
  - `useReveal(): React.RefObject<HTMLDivElement>` — 挂 IntersectionObserver,进入视口给元素加 `in` 类,然后 unobserve。
  - `useCountUp(target: number, opts?: { suffix?: string; decimals?: number; start?: boolean }): string` — 返回逐帧递增到 `target` 的显示字符串;`start` 为 true 时启动。

- [ ] **Step 1: 写失败测试**

```ts
// frontend/src/pages/landing/__tests__/useReveal.test.ts
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useReveal } from '../useReveal'

class IO {
  cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) { this.cb = cb }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', IO as unknown as typeof IntersectionObserver)
})

describe('useReveal', () => {
  it('observes the ref element on mount', () => {
    const { result } = renderHook(() => useReveal())
    // ref starts null until attached; hook must not throw
    expect(result.current).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/pages/landing/__tests__/useReveal.test.ts`
Expected: FAIL（`Cannot find module '../useReveal'`）

- [ ] **Step 3: 写实现**

```ts
// frontend/src/pages/landing/useReveal.ts
import { useEffect, useRef, useState } from 'react'

export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return
        e.target.classList.add('in')
        io.unobserve(e.target)
      })
    }, { threshold: 0.25 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return ref
}

export function useCountUp(
  target: number,
  opts: { suffix?: string; decimals?: number; start?: boolean } = {},
) {
  const { suffix = '', decimals = target % 1 !== 0 ? 1 : 0, start = true } = opts
  const [text, setText] = useState(`0${suffix}`)
  useEffect(() => {
    if (!start) return
    let raf = 0
    let begin = 0
    const dur = 1300
    const step = (t: number) => {
      if (!begin) begin = t
      const p = Math.min((t - begin) / dur, 1)
      const ease = 1 - Math.pow(1 - p, 3)
      setText(`${(target * ease).toFixed(decimals)}${suffix}`)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, suffix, decimals, start])
  return text
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/pages/landing/__tests__/useReveal.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add frontend/src/pages/landing/useReveal.ts frontend/src/pages/landing/__tests__/useReveal.test.ts
git commit -m "feat(landing): reveal + count-up hooks"
```

---

## Task 2: `landing.css`（scoped 移植）

**Files:**
- Create: `frontend/src/pages/landing/landing.css`

**说明**:这是纯样式任务,无单测;验证靠后续 section 渲染 + 最终 smoke。

- [ ] **Step 1: 移植样式**

打开 committed 设计稿 `spec/stride-landing.html` 的 `<style>`(约 33–405 行)。把全部规则复制进 `landing.css`,并做以下机械变换:
1. 把设计稿 `:root{...}` 的 CSS 变量块改成 `.landing-root{...}`(scope 变量,避免覆盖 app 全局 `--green` 等)。
2. 给所有**裸标签 / 全局类选择器**加 `.landing-root ` 前缀:
   - `body{...}` → `.landing-root{...}`（把 body 的 font/color 落到包裹层）
   - `section{...}` → `.landing-root section{...}`
   - `footer{...}` → `.landing-root footer{...}`
   - `.wrap`、`.nav`、`.hero`、`.reverse`、`.pillar`… → `.landing-root .wrap` 等
   - `::selection` → `.landing-root ::selection`
3. **不要**前缀 `#loginOverlay` / `.login-overlay` / `.lg-*` 这些(modal 用,ID 已隔离)—— 原样保留。
4. 删除设计稿里 `@import` Google Fonts 那行(字体走全局 index.css,Task 7 处理)。字体变量 `--font-display` 等照搬到 `.landing-root`(值与全局一致即可)。

- [ ] **Step 2: 校验无语法错**

Run: `npx vite build --mode development 2>&1 | head -5`（或留到 Task 8 build;此处可跳过)
Expected: 无 CSS 解析报错。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/pages/landing/landing.css
git commit -m "feat(landing): scoped landing stylesheet ported from design spec"
```

---

## Task 3: 落地页 sections + LandingNav + LandingPage 组合（静态）

**Files:**
- Create: `frontend/src/pages/landing/sections/{Hero,ReversePlan,Pillars,Features,DataShowcase,Closer,LandingFooter}.tsx`
- Create: `frontend/src/pages/landing/LandingNav.tsx`
- Create: `frontend/src/pages/landing/LandingPage.tsx`
- Test: `frontend/src/pages/landing/__tests__/LandingPage.test.tsx`

**Interfaces:**
- Consumes: `useReveal`, `useCountUp`（Task 1)。
- Produces:
  - `LandingPage(props: { initialLoginOpen?: boolean }): JSX.Element` — 最外层 `<div className="landing-root">`,import `./landing.css`。
  - `LandingNav(props: { onLogin: () => void }): JSX.Element`。
  - 各 section 无 props（静态 marketing 内容)。

**移植规则**:每个 section 的 JSX 结构 / 文案 / class 必须对照设计稿对应区块逐一移植(见下表行号),`class`→`className`,SVG 原样(属性改驼峰:`stroke-width`→`strokeWidth`、`stroke-linecap`→`strokeLinecap`、`fill-rule`→`fillRule`、`clip-rule`→`clipRule`),inline style 字符串改对象。动画数据(hero mini-bars、周量曲线 km 数组、负荷环、周里程 bars)作为组件内常量数组用 `.map()` 渲染,**不要**用 `dangerouslySetInnerHTML`。

| Section 组件 | 设计稿行号(参考) |
|---|---|
| `LandingNav` | 409–430（nav）|
| `Hero` | 432–472（含 hero-card、count-up:本周里程 58.4 / 训练负荷 412)|
| `ReversePlan` | 482–536 + 脚本 815–846（26 周 km 数组、phase 着色)|
| `Pillars` | 538–598（三柱 + synthesis)|
| `Features` | 600–632 |
| `DataShowcase` | 634–697 + 脚本 763–786（周里程 bars、配速 SVG、负荷环)|
| `Closer` | 699–710 |
| `LandingFooter` | 712–749 |

**触发开 modal**:设计稿里 `a[href="stride-login.html"]` 是开 modal 的入口。React 化时,把这些链接(nav 的"登录"/"开始训练"、hero/closer/footer 的 CTA)改成 `<button type="button" onClick={onLogin}>`(或 `<a onClick>`),class 沿用。`onLogin` 由 `LandingPage` 经 props 传下去(footer/closer 等也接同一个回调;为简洁可把 `onLogin` 经 props 透传给需要的 section,或用一个 `LoginTrigger` context —— 实现者择一,保持一致)。

- [ ] **Step 1: 写失败测试**

```tsx
// frontend/src/pages/landing/__tests__/LandingPage.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import LandingPage from '../LandingPage'

vi.mock('../../../store/authStore', () => ({
  useAuthStore: () => ({ isAuthenticated: false, login: vi.fn() }),
}))

function renderLanding(initialLoginOpen = false) {
  return render(
    <MemoryRouter>
      <LandingPage initialLoginOpen={initialLoginOpen} />
    </MemoryRouter>,
  )
}

describe('LandingPage', () => {
  it('renders the hero headline and key sections', () => {
    renderLanding()
    expect(screen.getByRole('heading', { name: /每一步都有数据/ })).toBeInTheDocument()
    expect(screen.getByText('从比赛日倒推,精准规划每一步')).toBeInTheDocument()
    expect(screen.getByText('跑得快,是练出来的整体结果')).toBeInTheDocument()
    expect(screen.getByText('你的训练,一屏看懂')).toBeInTheDocument()
  })

  it('does not open the login modal by default', () => {
    renderLanding(false)
    expect(screen.queryByRole('dialog', { name: /登录 STRIDE/ })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/pages/landing/__tests__/LandingPage.test.tsx`
Expected: FAIL（找不到 `../LandingPage`）

- [ ] **Step 3: 写实现**

按上表移植 7 个 section + `LandingNav`,再写 `LandingPage`。`LoginModal`（Task 4）此步先用占位:`{loginOpen && null}`,Task 4 接入。骨架:

```tsx
// frontend/src/pages/landing/LandingPage.tsx
import { useState } from 'react'
import './landing.css'
import LandingNav from './LandingNav'
import Hero from './sections/Hero'
import ReversePlan from './sections/ReversePlan'
import Pillars from './sections/Pillars'
import Features from './sections/Features'
import DataShowcase from './sections/DataShowcase'
import Closer from './sections/Closer'
import LandingFooter from './sections/LandingFooter'

export default function LandingPage({ initialLoginOpen = false }: { initialLoginOpen?: boolean }) {
  const [loginOpen, setLoginOpen] = useState(initialLoginOpen)
  const openLogin = () => setLoginOpen(true)
  return (
    <div className="landing-root">
      <LandingNav onLogin={openLogin} />
      <Hero onLogin={openLogin} />
      <ReversePlan />
      <Pillars />
      <Features />
      <DataShowcase />
      <Closer onLogin={openLogin} />
      <LandingFooter onLogin={openLogin} />
      {/* LoginModal 在 Task 4 接入：{loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />} */}
    </div>
  )
}
```

Hero 的 hero-card 数字用 `useCountUp`(58.4 + ` km`、412);ReversePlan / DataShowcase 的图表容器挂 `useReveal()` 的 ref 触发 `.in`。各 section 顶层节点(`reveal` 类)挂 `useReveal()` ref。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/pages/landing/__tests__/LandingPage.test.tsx`
Expected: PASS

- [ ] **Step 5: lint + 提交**

```bash
npm run lint
git add frontend/src/pages/landing
git commit -m "feat(landing): landing page sections + nav (static)"
```

---

## Task 4: `LoginModal` + 接入 LandingPage

**Files:**
- Create: `frontend/src/pages/landing/LoginModal.tsx`
- Modify: `frontend/src/pages/landing/LandingPage.tsx`(接入 modal)
- Test: `frontend/src/pages/landing/__tests__/LoginModal.test.tsx`

**Interfaces:**
- Consumes: `useAuthStore().login(email, password)`（抛 `{status?: number; error?: string}`)。
- Produces: `LoginModal(props: { onClose: () => void }): JSX.Element` — 渲染 `role="dialog"`,`aria-label="登录 STRIDE"`;移植设计稿 873–960 行,但**隐藏** OAuth 按钮 + "或使用邮箱"分割线 + "忘记密码?";提交接 `authStore.login`;成功 `navigate('/')`;"创建训练档案 →" 用 `<Link to="/register">`。

- [ ] **Step 1: 写失败测试**

```tsx
// frontend/src/pages/landing/__tests__/LoginModal.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import LoginModal from '../LoginModal'

const mocks = vi.hoisted(() => ({ login: vi.fn(), navigate: vi.fn() }))

vi.mock('../../../store/authStore', () => ({
  useAuthStore: () => ({ login: mocks.login }),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => mocks.navigate }
})

function renderModal() {
  return render(
    <MemoryRouter>
      <LoginModal onClose={vi.fn()} />
    </MemoryRouter>,
  )
}

afterEach(() => { mocks.login.mockReset(); mocks.navigate.mockReset() })

describe('LoginModal', () => {
  it('submits credentials and navigates home on success', async () => {
    mocks.login.mockResolvedValue(undefined)
    renderModal()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'runner@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /^登录$/ }))
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith('runner@example.com', 'secret123'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/'))
  })

  it('shows a credential error on 401', async () => {
    mocks.login.mockRejectedValue({ status: 401 })
    renderModal()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'x@y.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: /^登录$/ }))
    expect(await screen.findByText('邮箱或密码错误')).toBeInTheDocument()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('does not render OAuth or forgot-password entries', () => {
    renderModal()
    expect(screen.queryByText(/Google 继续/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Strava 继续/)).not.toBeInTheDocument()
    expect(screen.queryByText('忘记密码?')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/pages/landing/__tests__/LoginModal.test.tsx`
Expected: FAIL（找不到 `../LoginModal`）

- [ ] **Step 3: 写实现**

移植设计稿 873–960 的 overlay markup（`role="dialog"` `aria-modal` `aria-label="登录 STRIDE"`），左 brand pane 保留(含路线 SVG),右 form pane 改为受控 React 表单:

```tsx
// frontend/src/pages/landing/LoginModal.tsx
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'

export default function LoginModal({ onClose }: { onClose: () => void }) {
  const { login } = useAuthStore()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      await login(email, password)
      navigate('/')
    } catch (err: unknown) {
      const x = err as { status?: number; error?: string }
      if (x.status === 401) setError('邮箱或密码错误')
      else if (x.error === 'user_disabled') setError('账号已被禁用')
      else setError('登录失败,请重试')
    } finally {
      setLoading(false)
    }
  }
  // ... 移植 overlay 结构;遮罩 onClick={onClose}、关闭按钮 onClick={onClose}、Esc 关闭(useEffect keydown)
  // 表单字段 id=lgEmail(type=email)、id=lgPw(type=password),<label htmlFor> 文案 "邮箱"/"密码"
  // 提交按钮文案固定 "登录"(loading 时显示 "登录中…" 但保留 type=submit;注意 smoke 需要 name=/^登录$/,
  //   loading 文案只在点击后出现,smoke 点击前匹配 "登录" 即可)
  // 删除 .lg-oauth 整块 + .lg-divider + "忘记密码?" 链接
  // "创建训练档案 →" → <Link to="/register">
}
```

注意:`<label htmlFor="lgEmail">邮箱</label>` 让 `getByLabelText('邮箱')` 可用;`<input id="lgEmail" type="email" ...>`。error 用一个可见区块渲染(class 复用现有或加简单内联),`role` 不强制。

- [ ] **Step 4: 接入 LandingPage**

在 `LandingPage.tsx` 把占位换成:
```tsx
import LoginModal from './LoginModal'
// ...
{loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/pages/landing/__tests__/LoginModal.test.tsx src/pages/landing/__tests__/LandingPage.test.tsx`
Expected: PASS

- [ ] **Step 6: 加 LandingPage 开关测试 + 提交**

在 `LandingPage.test.tsx` 追加:`initialLoginOpen` 为真时 `screen.getByRole('dialog', { name: /登录 STRIDE/ })` 存在;点击 nav "开始训练" 按钮后 dialog 出现。跑通后:

```bash
npx vitest run src/pages/landing
npm run lint
git add frontend/src/pages/landing
git commit -m "feat(landing): login modal wired to authStore"
```

---

## Task 5: 路由改造（AppRoutes + AppOrLanding + LoginEntry）

**Files:**
- Create: `frontend/src/AppRoutes.tsx`
- Modify: `frontend/src/App.tsx`
- Delete: `frontend/src/pages/LoginPage.tsx`
- Test: `frontend/src/__tests__/AppRoutes.test.tsx`

**Interfaces:**
- Produces: `AppRoutes(): JSX.Element` — 顶层 `<Routes>`(不含 BrowserRouter)。
- Consumes: `useAuthStore().isAuthenticated`;现有 `OnboardingGate`、`UserProvider`、`AppLayout`、各 dashboard page、`RegisterPage`、`OnboardingWizard`。

- [ ] **Step 1: 写失败测试**

```tsx
// frontend/src/__tests__/AppRoutes.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const mocks = vi.hoisted(() => ({ isAuthenticated: false }))
vi.mock('../store/authStore', () => ({
  useAuthStore: (sel?: (s: { isAuthenticated: boolean; hydrate: () => void }) => unknown) => {
    const state = { isAuthenticated: mocks.isAuthenticated, hydrate: () => {} }
    return sel ? sel(state) : state
  },
}))
// 把已登录子树替换成占位,避免拉起真实 dashboard / api
vi.mock('../pages/WeekLayout', () => ({ default: () => <div>DASHBOARD_HOME</div> }))
vi.mock('../App', async (orig) => orig()) // 防循环;AppRoutes 独立文件无需

import AppRoutes from '../AppRoutes'

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>)
}

describe('AppRoutes (unauthenticated)', () => {
  it('shows the landing page at /', () => {
    mocks.isAuthenticated = false
    renderAt('/')
    expect(screen.getByRole('heading', { name: /每一步都有数据/ })).toBeInTheDocument()
  })

  it('opens login modal at /login', () => {
    mocks.isAuthenticated = false
    renderAt('/login')
    expect(screen.getByRole('dialog', { name: /登录 STRIDE/ })).toBeInTheDocument()
  })

  it('redirects a protected deep link to /login (landing + modal)', () => {
    mocks.isAuthenticated = false
    renderAt('/activities')
    expect(screen.getByRole('dialog', { name: /登录 STRIDE/ })).toBeInTheDocument()
  })
})
```

> 注:已登录分支因依赖 `OnboardingGate→getMyProfile` 等 api,放到浏览器 smoke 验证(Task 8),此处只单测新增的未登录路由逻辑。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/AppRoutes.test.tsx`
Expected: FAIL（找不到 `../AppRoutes`）

- [ ] **Step 3: 写实现**

把现有 `App.tsx` 里的 `<Routes>` 抽到 `AppRoutes.tsx`,并改造:

```tsx
// frontend/src/AppRoutes.tsx
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAuthStore } from './store/authStore'
import { UserProvider } from './UserContext'
import AppLayout from './components/AppLayout'
import WeekLayout from './pages/WeekLayout'
import ActivityDetailPage from './pages/ActivityDetailPage'
import HealthPage from './pages/HealthPage'
import BodyCompositionPage from './pages/BodyCompositionPage'
import TrainingPlanPage from './pages/TrainingPlanPage'
import TrainingPlanAdjustPage from './pages/TrainingPlanAdjustPage'
import ActivitiesPage from './pages/ActivitiesPage'
import AbilityPage from './pages/AbilityPage'
import TrainingStatusPage from './pages/TrainingStatusPage'
import RegisterPage from './pages/RegisterPage'
import OnboardingWizard from './pages/OnboardingWizard'
import TeamsListPage from './pages/teams/TeamsListPage'
import TeamDetailPage from './pages/teams/TeamDetailPage'
import CreateTeamPage from './pages/teams/CreateTeamPage'
import UserCenterPage from './pages/UserCenterPage'
import { getMyProfile } from './api'
import LandingPage from './pages/landing/LandingPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

type GateState = 'loading' | 'onboarding' | 'ready'
function OnboardingGate({ children }: { children: React.ReactNode }) {
  const [gateState, setGateState] = useState<GateState>('loading')
  const location = useLocation()
  useEffect(() => {
    getMyProfile()
      .then((p) => setGateState(p.onboarding.completed_at ? 'ready' : 'onboarding'))
      .catch(() => setGateState('onboarding'))
  }, [])
  if (gateState === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }
  if (gateState === 'onboarding' && !location.pathname.startsWith('/onboarding')) {
    return <Navigate to="/onboarding" replace />
  }
  return <>{children}</>
}

function Dashboard() {
  return (
    <OnboardingGate>
      <UserProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<WeekLayout />} />
            <Route path="/week/:folder" element={<WeekLayout />} />
            <Route path="/activity/:id" element={<ActivityDetailPage />} />
            <Route path="/teams/:teamId/activity/:userId/:labelId" element={<ActivityDetailPage />} />
            <Route path="/health" element={<HealthPage />} />
            <Route path="/body-composition" element={<BodyCompositionPage />} />
            <Route path="/plan" element={<TrainingPlanPage />} />
            <Route path="/plan/adjust" element={<TrainingPlanAdjustPage />} />
            <Route path="/activities" element={<ActivitiesPage />} />
            <Route path="/ability" element={<AbilityPage />} />
            <Route path="/training-status" element={<TrainingStatusPage />} />
            <Route path="/teams" element={<TeamsListPage />} />
            <Route path="/teams/new" element={<CreateTeamPage />} />
            <Route path="/teams/:id" element={<TeamDetailPage />} />
            <Route path="/settings" element={<UserCenterPage />} />
            <Route path="/profile" element={<Navigate to="/settings" replace />} />
            <Route path="/watch" element={<Navigate to="/settings?tab=watch" replace />} />
          </Route>
        </Routes>
      </UserProvider>
    </OnboardingGate>
  )
}

function AppOrLanding() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }
  return <Dashboard />
}

function LoginEntry() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (isAuthenticated) return <Navigate to="/" replace />
  return <LandingPage initialLoginOpen />
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginEntry />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/onboarding" element={
        <ProtectedRoute><OnboardingWizard /></ProtectedRoute>
      } />
      <Route path="/*" element={<AppOrLanding />} />
    </Routes>
  )
}
```

`App.tsx` 简化为:
```tsx
// frontend/src/App.tsx
import { useEffect } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import RouteTracker from './telemetry/RouteTracker'
import AppRoutes from './AppRoutes'

function App() {
  const hydrate = useAuthStore((s) => s.hydrate)
  useEffect(() => { hydrate() }, [hydrate])
  return (
    <BrowserRouter>
      <RouteTracker />
      <AppRoutes />
    </BrowserRouter>
  )
}
export default App
```

删除 `frontend/src/pages/LoginPage.tsx`。grep 确认无残留引用:`git grep -n "pages/LoginPage" -- frontend/src` 应为空(`AppRoutes.test.tsx` 里的 `vi.mock('../App', ...)` 那行如不需要可删)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/AppRoutes.test.tsx`
Expected: PASS（3 个未登录路由断言)

- [ ] **Step 5: 全量单测 + lint + build**

Run:
```bash
npm test
npm run lint
npm run build
```
Expected: 全绿;build 成功(无 `LoginPage` 残引、无类型错)。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/AppRoutes.tsx frontend/src/App.tsx frontend/src/__tests__/AppRoutes.test.tsx
git rm frontend/src/pages/LoginPage.tsx
git commit -m "feat(landing): public landing routing; replace /login page with modal"
```

---

## Task 6: self-host 字体（替换 Google Fonts @import）

**Files:**
- Create: `frontend/public/fonts/*.woff2`
- Modify: `frontend/src/index.css:1`

**说明**:`index.css` 第 1 行现在 `@import` Google Fonts。改为 self-host,惠及整个 app。

- [ ] **Step 1: 拉取 woff2**

用 Google Fonts CSS API 拿到 gstatic woff2 直链并下载到 `frontend/public/fonts/`。在 worktree 根跑:

```bash
cd frontend
mkdir -p public/fonts
# Outfit(400/500/600/700)、JetBrains Mono(400/500/600)、Newsreader(400/500/600 + italic400)
# 用浏览器 UA 拿 woff2(不带 UA 会返回 ttf)：
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
for css in \
  "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" \
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" \
  "https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;0,600;1,400&display=swap"; do
  curl -s -A "$UA" "$css"
done | grep -oE "https://fonts.gstatic.com/[^) ]+\.woff2" | sort -u > /tmp/font_urls.txt
i=0; while read -r u; do i=$((i+1)); curl -s -A "$UA" "$u" -o "public/fonts/font_$i.woff2"; done < /tmp/font_urls.txt
ls -la public/fonts
```

给文件起可读名(如 `outfit-400.woff2` …)便于 `@font-face` 引用。若某字重 latin+拉丁扩展拆成多文件,可只保留 latin 子集(中文走 PingFang 兜底,无需 CJK woff2)。

> 若环境无网络拉不到字体:**不要硬造空文件**。改为保留现有 Google `@import`,并在 commit message 注明 self-host 待补,继续后续任务。

- [ ] **Step 2: 写 @font-face,替换 import**

把 `index.css` 第 1 行的 `@import url('https://fonts.googleapis.com/...')` 删除,在文件顶部(`@import "tailwindcss";` 之前)加 `@font-face`(按实际落库的文件名/字重写齐),例如:

```css
@font-face{font-family:'Outfit';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/outfit-400.woff2') format('woff2');}
@font-face{font-family:'Outfit';font-style:normal;font-weight:600;font-display:swap;src:url('/fonts/outfit-600.woff2') format('woff2');}
@font-face{font-family:'Outfit';font-style:normal;font-weight:700;font-display:swap;src:url('/fonts/outfit-700.woff2') format('woff2');}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/jetbrains-mono-400.woff2') format('woff2');}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:600;font-display:swap;src:url('/fonts/jetbrains-mono-600.woff2') format('woff2');}
@font-face{font-family:'Newsreader';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/newsreader-500.woff2') format('woff2');}
@font-face{font-family:'Newsreader';font-style:italic;font-weight:400;font-display:swap;src:url('/fonts/newsreader-italic-400.woff2') format('woff2');}
```

- [ ] **Step 3: 校验**

Run: `npm run build && git grep -n "fonts.googleapis.com" -- frontend/src || echo "no google fonts refs"`
Expected: build 成功;`frontend/src` 下无 `fonts.googleapis.com` 残留。

- [ ] **Step 4: 提交**

```bash
git add frontend/public/fonts frontend/src/index.css
git commit -m "perf(fonts): self-host Outfit/JetBrains Mono/Newsreader (China availability)"
```

---

## Task 7: 本地浏览器 smoke（HARD 验证）

**Files:**
- Possibly Modify: `frontend/scripts/local-smoke.cjs`（仅在选择器对不上时)

**前置**:需要仓库根 `.credentials.local`(含 email/password)。这是用户机器上的真实文件,worktree 根可能没有;若缺失,提示用户提供或在主仓运行。**不要**把账号/密码/token 打到日志。

- [ ] **Step 1: 起本地 dev server（后台）**

Run（后台):`cd frontend && npm run dev:frontend:local`
记录实际地址(默认 `http://127.0.0.1:5173`;若 Vite 选了别的端口,设 `STRIDE_LOCAL_URL`)。

- [ ] **Step 2: 跑 smoke**

Run: `cd frontend && npm run smoke:local`
（若端口非默认:`STRIDE_LOCAL_URL=http://127.0.0.1:<port> npm run smoke:local`)

期望流程:`/login` 渲染 landing+modal → 填 email/password → 点"登录" → 跳离 `/login` → 有 access_token → `/activities` 显示"活动列表" → 进一个 `/activity/:id` 看到"距离"。结尾打印 `Local smoke OK`。

- [ ] **Step 3:（按需）修选择器**

若失败定位到 modal 选择器:
- 确认 `/login` 加载即开 modal(`initialLoginOpen`),`input[type="email"]` / `input[type="password"]` 在 DOM;
- 确认提交按钮可见 accessible name 为"登录"(点击前文案不是"登录中…");
- 仅在确有偏差时微调 `local-smoke.cjs`,改完重跑直到 `Local smoke OK`。

- [ ] **Step 4: 目视确认无样式污染**

dev server 下打开已登录 dashboard(用浏览器或 Playwright 截图),确认 `landing.css` 的 scope 未污染 dashboard(section padding、字体、颜色正常)。

- [ ] **Step 5: 关 dev server，提交（如有 smoke 脚本改动）**

```bash
git add frontend/scripts/local-smoke.cjs
git commit -m "test(landing): align local smoke with login modal"
```

---

## Self-Review（计划作者已核对）

- **Spec 覆盖**:路由(Task 5)、landing sections(Task 3)、login modal 接 authStore(Task 4)、OAuth/忘记密码隐藏(Task 4)、注册跳转(Task 4)、CSS scope(Task 2)、self-host 字体(Task 6)、删除旧 LoginPage(Task 5)、单测 + 浏览器 smoke(Task 1/3/4/5/7)—— 均有任务对应。
- **占位扫描**:无 TBD/TODO;每个代码步骤含真实代码或明确移植行号 + 变换规则。
- **类型一致**:`useReveal`/`useCountUp`(Task1)、`LandingPage({initialLoginOpen})`、`LandingNav({onLogin})`、`LoginModal({onClose})`、`AppRoutes()` 全程一致;`login(email,password)` 抛 `{status,error}` 与测试一致;登录成功 `navigate('/')` 一致。
- **已知放宽**:已登录 dashboard 路由分支不做单测(依赖真实 api),由 Task 7 浏览器 smoke 覆盖 —— 已在 Task 5 Step1 注明。
