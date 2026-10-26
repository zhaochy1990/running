小程序→SwiftUI 转译映射表（devops #749 / 地图 #746）

# 小程序 → SwiftUI 转译映射表

> devops #749 · wayfinder 地图 #746（SwiftUI iOS App 迁移，以小程序为样板）
> 证据基线：`running/src/wechat-miniprogram/`（29 注册页，活跃 27；四 tab）+ Flutter 参考 `running/mobile/lib/core/theme/`。
> 用法：各域规格票直接引用本文条目编号（如「§4 导航栏」「§9 降级 D-3」），不重开已决问题。

---

## 0. 总则

- **一切以小程序现行实现为功能样板**（含暗色视觉、文案、交互细节），SwiftUI 侧给「机械对应 + 注意点」；颜色**数值**不盲抄——#413 已决「App 亮色定调」，最终色板由 iOS 设计 token 票收口，本表只保证**结构与尺度**可无损转译。
- 小程序两套 token 并存：`app.wxss`（page 级浅色变量，实际大部分页面未用）与 `styles/dark.wxss`（深色页共享令牌，7 页 @import）。多数页面 wxss 直接内联硬编码 hex（如 `#070708`/`#101111`/`#8a8a8c`）。**SwiftUI 侧不要复刻「两套变量+大量内联」的现状**，落成一个 `StrideTheme`（Color 扩展 + 尺度常量），per-page parity check 时把内联色归位到 token。
- Flutter 参考（`mobile/lib/core/theme/tokens.dart`：亮色 Vercel 系、accent 绿 `#1FAD5B`、字号/圆角/间距三套刻度）证明「CSS 变量 → 静态 token 类」转译路径可行，SwiftUI 同构：`enum StrideTokens` / `Color.stride.*` + `CGFloat` 间距刻度。
- 度量换算统一走 **rpx→pt = rpx/2**（§2），布局优先用 SwiftUI 声明式容器而非换算后的绝对定位。

---

## 1. wxml 结构 → SwiftUI 视图组合

| 小程序做法 | SwiftUI 对应 | 注意点 |
|---|---|---|
| `<view>`（通用容器） | `VStack` / `HStack` / `ZStack` / `Group` 按布局意图选 | wxml 的 view 是「无语义块」，靠 wxss 的 `display:flex` 定方向；转译时**读 wxss 而不是猜 wxml**：`flex-direction:row` → `HStack`，`column` → `VStack`，`position:absolute` 叠层 → `ZStack` |
| `wx:if` / `wx:elif` / `wx:else` | ViewBuilder 内 `if / else if / else` | 结构等价；SwiftUI 分支即不同 View 类型，不需要额外包装 |
| `<block>`（纯逻辑分组，不渲染） | `Group` 或直接展开到父 ViewBuilder | `<block wx:if>` 分段（如 index 页营养卡、strategy 页 error/正常态切换）→ `Group { if … } else { … }` |
| `wx:for="{{list}}" wx:key="id"` | `ForEach(list, id: \.id)` | `wx:key` 即 `Identifiable`/`id:` keyPath；`wx:for-index` → `ForEach(Array(list.enumerated()), id:\.offset)`（避免，尽量给模型加稳定 id） |
| `bindtap` + `data-xxx` 取参数 | `Button { onTap(item) } label: { … }` 闭包直接捕获 | 消灭 dataset 反查：小程序靠 `e.currentTarget.dataset.id` 反查数据，SwiftUI 在 ForEach 里直接捕获 `item`，**不需要 dataset 约定** |
| `catchtap`（拦冒泡）/`bindtap`（冒泡） | 内层 `Button` 天然优先于外层 `onTapGesture` | 小程序「卡片整体可点 + 内层按钮拦冒泡」（index 今日卡、strategy hero）在 SwiftUI 免役：`Button` 优先级自动高于父级 tap gesture，直接两层嵌套即可 |
| `<image src mode="aspectFit/aspectFill" lazy-load>` | 本地/资源：`Image(...)`；网络：`AsyncImage(url:)`，`aspectFit`→`.scaledToFit()`，`aspectFill`→`.scaledToFill()`+`.clipped()` | `binderror` 回退（缩略图失败回退运动图标，index/activities 页）→ `AsyncImage` 的 `error` 分支视图 |
| `<text>` | `Text` | 多段拼接 `{{a}} · {{b}}` → `Text(a + " · " + b)` 或 `Text` 插值拼接（保持同一个 Text 以共享样式） |
| `<button open-type=...>` | 见 §9 降级清单 | |
| `<input>` / `<textarea>`（blur 落值） | `TextField` / `TextEditor`（两向绑定，实时落值） | 小程序「blur 才落值 + dirty 标记」（strategy 配速表编辑）→ SwiftUI 直接 `.onChange` 实时写 model；dirty 语义保留在 model 层 |
| `<scroll-view scroll-y scroll-into-view>` | `ScrollView { ... } .scrollPosition` / `ScrollViewReader.scrollTo(id, anchor:)` | coach 聊天列表自动滚底、feedback 抽屉列表都是 scroll-view → ScrollViewReader |
| `<map>`（activity-detail 轨迹） | `Map`（MapKit SwiftUI） | **坐标勿转**：小程序用 `wgs84ToGcj02` 预转 GCJ-02（腾讯瓦片），iOS 直传 WGS-84 原始点，MapKit 中国区自动加偏（地图 #746 已决）；polyline 分段着色 → `MapPolyline` 按 chunk 逐段配色 |
| `<canvas type="2d">`（图表/海报） | 见 §6 | |
| 页面 `data` + `this.setData` | `@State` / `@Observable` model 属性直改 | setData 的「路径更新」（`'view.paceRows'`）→ 直接改 model 属性；渲染 diff 自动 |
| 模块级可变状态（`let fetchedPlan`、`weekSessions`，index/strategy 页） | 页面 ViewModel（`@Observable final class`）持有 | 小程序因 Page 实例无法挂非渲染字段而放模块级；SwiftUI 归位到 VM 属性，随视图生命周期释放 |
| `components/` 自定义组件（coach-card、push-date-sheet、roadmap-panel、mp-html） | 同名 SwiftUI `View` struct 复用 | `push-date-sheet`（弹层）→ `.sheet`；`mp-html`（coach 富文本 markdown）→ `AttributedString(markdown:)` 或简易 markdown 渲染器；**先查 content 实际是 markdown 而非任意 HTML**（`utils/markdown.ts` 是自研 md 转换），大概率不需要 WKWebView |
| `custom-tab-bar/`（app.json `tabBar.custom: true`，各 tab 页 onShow `getTabBar().setData({selected})`） | `TabView(selection:)` + 自定义底栏样式（iOS 18 `TabView` sidebar API 或 iOS 16 兼容自绘底栏） | 选中态同步 hack 消失：selection 双向绑定；四 tab：coach/activities/index/profile |
| `wx:if` 大法渲染的 loading / error / empty 三态（spinner、banner、empty-card） | 泛型 `LoadableContent` 容器或各页手写三态 | 小程序三态是全局惯例（state-card/banner--error/empty-card + `.spinner` CSS 动画 → `ProgressView()`），SwiftUI 建议抽一个共用组件对齐视觉 |

---

## 2. wxss + rpx → SwiftUI 布局与 token

### 2.1 单位换算（375 设计稿基准）

**`pt = rpx / 2`**（小程序 750rpx = 屏宽；375pt 基准机型上 1rpx=0.5pt）。落法：

- SwiftUI 全用 pt，**不做屏宽比例缩放**——小程序 rpx 在 Pro Max（430pt）上会被拉大 ~15%，SwiftUI 布局本来自适应（HStack 分布、Spacer、GeometryReader 按需），文字不该随屏宽变号。**设计稿（375 基准）上的 rpx 一律 ÷2 进 SwiftUI**。
- 例外：`statusBarHeight`/胶囊相关的手算 padding（index 页 `contentPaddingTopRpx()`）**不转译**——SwiftUI safe area + NavigationStack 免费拿到，整段删除（§4）。
- 海报 canvas 坐标系是 px 不是 rpx（strategy 海报 600×N、dpr=2），SwiftUI 侧同样用逻辑 pt 画，`ImageRenderer.scale` 承担 dpr（§6）。

常用尺度速查（小程序惯例值 → pt）：

| wxss 惯例 | rpx | SwiftUI pt |
|---|---|---|
| 页面水平 padding / 卡片间距 | 24rpx | 12 |
| 卡片内边距 | 28~32rpx | 14~16 |
| 卡片圆角 | 16rpx / 24rpx | 8 / 12 |
| 顶栏内容高 | 128rpx | 64 |
| 正文/次要文字 | 26rpx / 24rpx | 13 / 12 |
| 卡片标题 | 30~32rpx | 15~16 |
| hero 大标题 | 40~44rpx | 20~22 |
| 顶栏图标钮 | 72rpx | 36 |
| spacing 刻度（app.wxss --spacing-*） | 8/16/24/32/48rpx | 4/8/12/16/24 |

### 2.2 布局模式映射

| 小程序做法 | SwiftUI 对应 | 注意点 |
|---|---|---|
| `display:flex; flex-direction:row; align-items:center` | `HStack(alignment: .center)` | gap → `spacing:` |
| `flex-direction:column` | `VStack(alignment: .leading/…)` | 文字列一般 `.leading` |
| `justify-content:space-between`（flex-between 工具类） | `HStack { leading; Spacer(); trailing }` | |
| `flex:1`（顶栏标题 `flex:1` 占满） | `.frame(maxWidth: .infinity)` | |
| 多列 stat 行（`stat-row`，每项 flex:1 居中） | `HStack { ForEach(stats) { stat } }` + 每项 `.frame(maxWidth:.infinity)` | 或 `Grid` |
| `position:fixed` 顶栏（top-bar，z-index + 全页 padding-top 让位） | `.safeAreaInset(edge:.top)` 或系统 navigationBar | 转译原则：**fixed 顶栏一律升级为系统容器**（§4），不再手 padding |
| `position:fixed; left:-2000rpx`（隐藏 canvas） | 离屏画法消失：`ImageRenderer` 渲染不可见 view | 海报不需要挂在页面树里（§6） |
| `backdrop-filter:blur(12px)` + 半透明底 | `.background(.ultraThinMaterial)` | 顶栏毛玻璃视觉对齐 |
| `border:1rpx solid rgba(255,255,255,0.06)` | `.overlay(RoundedRectangle().strokeBorder(Color.white.opacity(0.06)))` | 1rpx → 0.5pt 描边 |
| `border-radius` | `.clipShape(RoundedRectangle(cornerRadius:))` / `.cornerRadius()` | 卡片配 `.clipShape` 保证内容裁切 |
| `.spinner` `@keyframes spin` CSS 动画 | `ProgressView().controlSize(.regular)` | 主题色环 → `.tint(.stride.accent)` |
| `transition`/`animation` | `.animation(.default, value:)` / `withAnimation` | 小程序动画极少（仅 spinner），不设专门映射 |
| page 级 `--color-*` CSS 变量 | `extension Color { static let … }` 或 `enum StrideTokens` | dark.wxss 全部 26 个变量（bg/bg-sunken/card/chip/text 六档/accent 藕粉系/success 系）原样搬成一套 token；数值是否沿用暗色由设计票定（§0） |
| `safe-area-inset-bottom` 适配（底栏/CTA） | SwiftUI 自动；钉底 CTA 用 `.safeAreaInset(edge:.bottom)` | |
| `text-align:center` 标题（top-bar__title-wrap flex:1 + center） | `.frame(maxWidth:.infinity)` 内 `Text` 或系统导航标题 | 系统导航标题即居中，转译后消失 |

---

## 3. 自定义导航栏 → NavigationStack / Toolbar / 返回手势

**小程序约定（20 个非 tab 页统一实现）**：`navigationStyle:"custom"` 自绘顶栏 = `statusBarHeight` padding + 128rpx 内容条 + 毛玻璃；左侧按钮 `canBack = getCurrentPages().length > 1` ? 返回箭头（chevron_right.svg 旋转 180°）: `home.svg` 小房子；标题（+副标题）居中；右侧占位（胶囊保留区）。返回动作 `wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) })`——**fail 兜底 20/20 全部指向教练 tab**（深链/分享冷开时栈空，回不去就回家）。

**SwiftUI 对应**：

| 小程序做法 | SwiftUI 对应 | 注意点 |
|---|---|---|
| `navigationStyle:"custom"` 自绘 top-bar | `NavigationStack` + `.navigationBarTitleDisplayMode(.inline)` + `.toolbar` | **默认不自绘**：系统返回按钮 + 边缘右滑返回手势免费获得（小程序没有系统手势，iOS 有，别丢了）。视觉对齐（毛玻璃/深底）用 `.toolbarBackground(.visible, for: .navigationBar)` + `.toolbarColorScheme(.dark)` |
| `canBack` 箭头 | 系统返回按钮 | 系统在栈深>1 时自动出现，无需判断 |
| `home.svg` 小房子（栈深=1，深链冷开） | **深链接入时给 path 填根**：`NavigationStack(path:)` 冷开落点 = `[.homeTabRoot, .detail(id)]`，返回自然落到该 tab 根页 | 关键策略：iOS 不该出现「栈深=1 的孤儿详情页」。深链/分享回流冷开时把落点 push 在一个合理的 tab 根之上，系统返回手势永远有处可退，**小房子按钮整体消失**。若个别页（如 strategy-share 只读落地页）确需「直接回主页」，用 `.toolbar { ToolbarItem(.navigation) { Button(house) } }` 显式落 coach tab，等价兜底 |
| `onBack` fail → switchTab coach | `dismiss()` 在栈底时自然无效 → 上述 path 填根策略下不触发；兜底按钮同上 | |
| 右侧胶囊保留区（top-bar__btn--spacer） | 删除 | iOS 无胶囊；右侧 toolbar 可放真实动作（如分享） |
| 顶栏副标题（top-bar__title + __subtitle） | `.toolbar { principal }` 自定义标题视图（title+subtitle VStack） | index 页周次副标题、activity-detail 日期副标题用 |
| tab 页顶栏（index 菜单钮/标题/副标题） | `.toolbar { ToolbarItem(.navigation) { menu } }` + `.navigationTitle` | index 的「暂未开放」菜单钮保留占位 |
| `wx.setNavigationBarTitle` 动态标题 | `.navigationTitle(...)` 直改 | |

---

## 4. 页面路由：wx.* 导航 API → NavigationStack path + TabView

### 4.1 全局路由表

- 小程序：`app.json` pages 字符串表 + 页内 `wx.navigateTo({url: '/pages/x/x?id=1'})` 拼 query。
- SwiftUI：**单一 `Route` enum（每页一个 case + 强类型关联值）作为全局路由表**，替代字符串路径：

```swift
enum Route: Hashable {
  case activityDetail(labelId: String)
  case workoutDetail(date: String, workoutId: String, title: String)
  case raceCenter                            // tab 根
  case raceDetail(id: Int)
  case raceStrategy(id: Int, target: String?)
  case strategyShare(user: String, id: Int, version: Int)   // 公开落地页
  // …27 活跃页逐一入表
}
```

- 小程序页间传参全是 query 字符串（实测参数面：`id`、`user`、`workout`、`version`、`labelId`、`date/title`、`redirect`、`scene/sid`）→ 关联值承接，编译期查错。
- `utils/redirect.ts` 的 `sanitizeRedirect`（挡 `//`、`://` 开放重定向）→ `Route(url:)` 解析器只接受白名单 path+参数，非法返回 nil，**同样语义更严**（分享回流 / 登录回跳共用）。

### 4.2 导航 API 逐条映射

| 小程序 | SwiftUI | 注意点 |
|---|---|---|
| `wx.navigateTo`（push，栈上限 10） | `path.append(route)`（NavigationStack path） | 无 10 层上限 |
| `wx.redirectTo`（替换当前页） | `path[path.count-1] = route` 或 `path.removeLast(); path.append(route)` | 2 处使用 |
| `wx.navigateBack` | `dismiss()` / `path.removeLast()` | |
| `wx.switchTab`（26 处；切 tab 并清非 tab 栈） | `selectedTab = .coach`（TabView binding） | 小程序 switchTab 销毁所有普通页栈；TabView 各 tab 保留自己的 NavigationStack path。**建议保持各 tab path 不清**（iOS 用户预期），parity check 记偏差 |
| `wx.reLaunch`（20 处：login×11、coach×2、onboarding、feedback、index…） | 分解为「重置根」：`selectedTab = X; tabPaths[X] = []`，若目标非 tab 根则 `[root, route]` | reLaunch = 全栈重建，SwiftUI 无单 API，封一个 `AppRouter.reset(to:)` |
| `switchTab` 不能带 query → 跨 tab 交接靠 storage（`setPendingCoachContext`/`setPendingStrategyDraft`，onShow 消费） | **升级为共享 `@Observable AppModel` 的 pending 属性**，switchTab 前直接赋值、目标 tab `onChange(selectedTab)` 消费 | 小程序 storage hack（含 `takePendingStrategyDraft` 一次性消费）在单进程 SwiftUI 下无必要，语义原样保留（挂起上下文 + 单次消费） |

### 4.3 冷启动落点与 deep link 骨架

- 小程序冷启动：`wx.getLaunchOptionsSync().path` 判入口 → `app.ts checkAuth()`：有 token → 验证（GET /api/users/me）→ `routeToOnboardingIfProfileMissing()`（档案缺 → reLaunch onboarding）；无 token → 微信免密登录 → 失败且非公开页 → reLaunch login（带 redirect 回跳）。公开落地页白名单 `PUBLIC_ENTRY_PAGES`（workout-share / strategy-share / coach-share）跳过强制跳转。
- SwiftUI 骨架：

```swift
@main struct StrideApp: App {
  @State private var app = AppModel()          // 会话 + pending 交接 + 选中 tab
  @State private var paths: [Tab: [Route]]     // 每 tab 一个 NavigationStack path

  var body: some Scene {
    WindowGroup {
      RootView()
        .task { await app.bootstrap(entry: deepLinkRoute) }  // 冷启动解析 + checkAuth 等价逻辑
        .onOpenURL { url in app.open(Route(url: url)) }      // 前台 deep link
    }
  }
}
```

- 冷启动落点决策树（对齐 app.ts）：deep link → Route（含分享回流 `/pages/race-center/strategy-share?user=&id=&version=` 三参数）→ 未登录 && `!route.isPublicLanding` → login（route 作回跳，登录成功恢复）→ 已登录 && 档案缺 → onboarding → 否则落 `paths[tab] = [root, route]`。
- 微信免密恢复（`recoverSession`/`silentLogin`，wx.login code 换 JWT）在 **iOS 不存在**（#419 边界：SMS + 邮箱密码）：会话失效链路只剩 refresh token 一次重试 → 失败即 login + redirect 回跳（§8）。

---

## 5. Canvas 海报绘制 → SwiftUI Canvas + ImageRenderer

**小程序做法**（strategy 配速卡 / workout-detail 分享封面 / coach-share 同构）：页面挂 `<canvas type="2d" id="poster">`（`position:fixed; left:-2000rpx` 离屏隐藏）→ `wx.createSelectorQuery().select('#poster')` 取节点 → `canvas.width = W*dpr; ctx.scale(dpr,dpr)` → 纯命令式绘制（fillRect/fillText/线条，px 坐标系，如 600×N）→ `wx.canvasToTempFilePath` 出临时文件 → `wx.previewImage`（长按保存）；workout-detail 还把临时文件喂给 `onShareAppMessage.imageUrl`。

**SwiftUI 对应**：

| 小程序做法 | SwiftUI 对应 | 注意点 |
|---|---|---|
| 离屏 `<canvas>` 节点 + selectorQuery | 海报写成**普通 SwiftUI View**（`StrategyPosterView(view:)`），不进页面树 | 绘制即布局：海报内元素用 VStack/HStack/Text 排，不用手算 y 坐标 |
| `ctx.fillRect` / `fillText` / `beginPath/moveTo/lineTo`（如需像素级复刻） | `Canvas { context, size in context.fill(Path(rect), with: .color(…)); context.draw(Text("…").font(…), at: point) }` | 两条路线二选一：**首选声明式海报 View**（自动布局、字体自适应、代码量 1/3）；仅当要像素级对齐小程序成品再走 Canvas/GraphicsContext。GraphicsContext API：`fillText`→`draw(Text)`、`fillRect`→`fill(Path)`、`stroke`→`stroke(Path, with:)` |
| `dpr=2` 缩放 | `ImageRenderer(content:).scale = UIScreen.main.scale`（或固定 2） | 渲染尺寸 = view 尺寸 × scale，对齐 `canvas.width = W*dpr` 语义 |
| `wx.canvasToTempFilePath` | `ImageRenderer.uiImage` / `render(rasterizationScale:)` | |
| `wx.previewImage`（长按保存） | 全屏 `fullScreenCover` 预览 + 底部「保存到照片」「分享」按钮；保存走 `UIImageWriteToSavedPhotosAlbum`（Info.plist 加 `NSPhotoLibraryAddUsageDescription`） | **降级点：iOS 预览无「长按保存」惯例**，改显式按钮，parity 记偏差 |
| 海报图喂分享卡 `imageUrl` | `ShareLink(item: Image, …)` 直接分享渲染出的 UIImage | iOS 分享卡即时呈现该图，无需预生成缓存 |
| activity-detail 的 uCharts 心率/配速曲线（`utils/curveChart.ts` + touch tooltip） | **Swift Charts**（`Chart { LineMark }` + `chartOverlay` 手势读位显 tooltip） | 图表不是 Canvas 绘制域，归 Charts；分档背景带（zoneBands）→ `RectangleMark`；tooltip 格式化函数（`spec.tooltip`）原样搬 Swift |

---

## 6. 下拉刷新 / onReachBottom / 生命周期

### 6.1 刷新与滚动

| 小程序做法 | SwiftUI 对应 | 注意点 |
|---|---|---|
| `enablePullDownRefresh` + `onPullDownRefresh` + `wx.stopPullDownRefresh`（activities / race-center / my-races / race-center detail 4 页） | `.refreshable { await model.fetch() }` | async 结束自动收起，stopPullDownRefresh 消失；fetch 逻辑须是可重入 async |
| `onReachBottom`（无限滚动） | ——（**小程序全库 0 处使用**，无需映射基线） | 如升级无限滚动：`LazyVStack` + 尾部哨兵 `onAppear { model.loadMoreIfNeeded() }` |
| 实际翻页惯例：尾部「加载更多」按钮（activities `hasMore` + `onLoadMore`，offset 翻页） | 1.0 **保持显式按钮**对齐 parity：`if model.hasMore { Button("加载更多") { Task { await model.loadMore() } } }` | `LazyVStack`/`List` 承载长列表（活动流/赛事列表）；是否升级自动无限滚动由各域票定 |
| `wx.pageScrollTo({scrollTop:0, duration:0})`（feedback/my-races 提交后回顶） | `ScrollViewReader` + `.scrollTo(topID, anchor:.top)`（proxyHolder）或翻转刷新态 | duration:0 → 无动画 scrollTo |
| scroll-view `scroll-into-view`（coach 聊天锚点滚动） | `ScrollViewReader.scrollTo("msg-\(id)", anchor:.bottom)` + `withAnimation` | |

### 6.2 生命周期

| 小程序 | SwiftUI | 注意点 |
|---|---|---|
| `onLoad`（一次，带 options query） | 视图 `.task { }`（或 init/onAppear）；query → Route 关联值注入 | 参数解析消失（§4.1） |
| `onShow`（每次页面可见：push 进来、tab 切回、**app 回前台**） | 组合信号：`.onAppear`（首次）+ `onChange(of: selectedTab)`（tab 切回）+ `onChange(of: scenePhase)` == `.active`（回前台） | 小程序三场景合一的 onShow 在 SwiftUI 拆三处；「切回 tab 静默刷新」（index onShow 重拉课表）建议封 `var isVisible` 派生值统一订阅。**注意 TabView 默认保活**：tab 首次构建后 onAppear 不再触发，tab 切回必须靠 selectedTab onChange |
| `onHide` | `scenePhase` → `.inactive`/`.background` | |
| `onUnload` | `.onDisappear` / VM `deinit` | |
| tab 页 onShow 里 `getTabBar().setData({selected})` | TabView selection 自动 | 消失 |
| `App.onLaunch` | `App.init` + RootView `.task { await bootstrap() }` | checkAuth 决策树见 §4.3 |
| `wx.nextTick`（setData 回调后再查 canvas 节点） | 不需要：SwiftUI 无「渲染后再取节点」时序问题 | |

---

## 7. 数据层：services + store → URLSession + Repository + @Observable

### 7.1 结构对应

| 小程序 | SwiftUI | 注意点 |
|---|---|---|
| `services/request.ts`（wx.request 包 Promise + `http.get/post/put/patch/delete` 泛型便捷层） | `APIClient`（actor 或 final class）：`URLSession.shared` + `async func get<T: Decodable>(_ path: Path) async throws -> T` | 头部约定原样搬：`Content-Type: application/json` + `X-Client-Id: app_895073719c0147368b8feed3` + `Authorization: Bearer …`；超时 15s（coach turn 600s 单列） |
| `ApiError {statusCode, code, detail}`（数据面 `{detail,code}` / auth 面 `{error,message}` 双格式归一） | 同名 Swift `ApiError`，解码两格式 | 错误文案兜底映射（各域 `BIND_ERROR_MESSAGES` 类）原样搬 |
| 401 → 单飞 `refreshPromise` 刷新 → 重试一次 → 仍失败 `handleSessionExpired` | APIClient 内同构：`refreshInFlight: Task<String, Error>?` 单飞 + 重试一次 | refresh 端点 `AUTH_BASE_URL/api/auth/refresh`，新 token 双写存储 |
| `handleSessionExpired` → 清 token → **微信免密恢复一次**（recoveredOnce guard 防死循环）→ 不行 reLaunch login 带 redirect | 清 Keychain → **免密恢复整段删除**（无 wx.login）→ 直接 login + redirect 回跳 | 恢复标记/recoveredOnce 随之消失；redirect 回跳保留（`sanitizeRedirect` → Route 校验） |
| token 存 `wx.setStorageSync`（access/refresh/expiresAt/userInfo 四 key） | refresh token 进 **Keychain**（地图已决）；access/expiresAt/userInfo 可 UserDefaults | 常量 `STORAGE_KEYS` 对应一套 `AuthStore` |
| `store/user.ts`（pub-sub class store：state/subscribe/emit + `authReady` Promise） | `@Observable final class SessionModel`；`authReady` → `var readyContinuation` / `func awaitReady() async` | 数据页 `await userStore.waitForAuth()` 再发请求（防首屏 401）的模式保留：VM `init` 里 `Task { await session.ready(); await load() }` |
| `app.ts` checkAuth 启动流程 | `AppModel.bootstrap()`（§4.3 决策树） | PUBLIC_ENTRY_PAGES → `Route.isPublicLanding` |
| 18 个域 service 文件（activities/auth/coach/race-center/…，纯函数 + 类型 + 端点封装） | 同名 Repository：`final class RaceCenterRepository { func detail(_ id: Int) async throws -> RaceDetail }`，`Codable` DTO 1:1 映射 `types/api.ts` | 端点零新增（地图已决）；视图变换纯函数（`utils/raceStrategyRows.ts` 等带 `.check.mts` 校验的）→ Swift 同构纯函数 + 单测搬用例 |
| `utils/sse.ts`（enableChunked + 手写 UTF-8 解码 + 事件边界解析，coach 四事件 status/text_delta/done/error） | `URLSession.bytes(for:)`：`for try await line in bytes.lines` 组装 event/data 帧 | **大幅简化**：bytes 流天然处理分块与 UTF-8，手写解码器整段删除；SSE 事件协议不变（Coach SSE 协议 #413 已决） |
| `wx.uploadFile`（头像上传、反馈图片） | `URLSession.upload(for:from:)` multipart | |
| `wx.getRealtimeLogManager` + console 日志脱敏（redact） | `os.Logger` 子系统；脱敏清单（password/code/token…）原样搬 | |
| 模块级缓存（`fetchedPlan`、`mapSegments`） | VM 属性；跨页共享缓存 → Repository 内缓存或 `@Observable` store | |

---

## 8. open-type 按钮与微信特有能力 → 降级策略清单

**先给定心丸：全库盘点（§10 频次表）证实 `wx.requestPayment`、`wx.openSetting`、`wx.requestSubscribeMessage`、`wx.authorize` 均为 0 使用**——票面担心的支付/设置授权在现网功能面上不存在，1.0 无需对等物；下列降级仅覆盖真实使用面。

| # | 小程序能力（实测用法） | iOS/SwiftUI 落法 | 策略 |
|---|---|---|---|
| D-1 | `open-type="share"` 转发按钮（7 处：coach/workout-detail/strategy/index 今日卡/coach-share；#626：小程序无代码唤起分享，必须走按钮） | `ShareLink(item:)`；或编程唤起 `UIActivityViewController`（representable 包一层） | **升级**：iOS 无此限制，任意手势/菜单都能唤起分享；按钮位置与视觉照抄 |
| D-2 | `onShareAppMessage` 动态标题/path（strategy 带 owner/race/version 三 id 进只读落地页）/`onShareTimeline` 朋友圈单页模式 | `ShareLink(item: URL)` —— universal link 承载同款 query（`?user=&id=&version=`），冷启动 Route 解析回流（§4.3）；**朋友圈分享无对等**，只留单一路分享 | 降级：timeline 渠道消失，parity 记偏差 |
| D-3 | `open-type="chooseAvatar"`（onboarding/profile-edit 微信头像） | `PhotosPicker`（PhotosUI）选图 + 裁圆；或默认头像列表 | 降级：微信灰底头像选择器不存在，改为系统相册 |
| D-4 | `wx.login` 免密登录/静默绑定（12 处，silentLogin/recoverSession） | 不存在；SMS 验证码 + 邮箱密码（#419 已决） | 移除：登录域票承接 18 错误码 |
| D-5 | `wx.showToast`（100 处，icon success/none） | 自定义 toast modifier（`overlay` + 自动消失）；success 态可对 `Image(systemName:"checkmark.circle.fill")` 短暂展示 | 对等实现（SwiftUI 无系统 toast，写一个 20 行的共享组件） |
| D-6 | `wx.showModal`（12 处，确认弹窗） | `.alert` + `confirmationDialog` | 对等 |
| D-7 | `wx.showActionSheet`（4 处，如「删除」菜单） | `.confirmationDialog` | 对等 |
| D-8 | `wx.showLoading/hideLoading`（5 处） | `.overlay { ProgressView() }` / 按钮 `progress` 状态（如 strategy 保存中） | 对等 |
| D-9 | `wx.previewImage`（3 处：配速卡/反馈图/分享卡） | `fullScreenCover` + 缩放查看 + 显式保存/分享按钮（§5） | 降级：长按保存 → 显式按钮 |
| D-10 | `wx.chooseMedia`（反馈表单，≤9 张、>10MB 跳过） | `PhotosPicker(selectionLimit: 9)` + 大小过滤 | 对等 |
| D-11 | `wx.setClipboardData`（2 处） | `UIPasteboard.general.string` + toast「已复制」 | 对等 |
| D-12 | `wx.getAccountInfoSync`（env/版本） | `Bundle`（版本号）/ 编译条件（DEBUG） | 对等 |
| D-13 | 右上角胶囊菜单（转发/设置/重新进入） | 无对等：设置移 App 内（我 tab），转发走 D-1 | 移除 |
| D-14 | （未使用，前瞻）微信支付 / openSetting / 订阅消息 | 若未来小程序端加支付，iOS 等价物必须 IAP，届时单独立票 | 记录边界 |

---

## 9. 样本页验证（三页「概念 → 落法」）

### 9.1 pages/index/index（训练 tab，复杂度：中）

| 该页用到的概念 | SwiftUI 落法 |
|---|---|
| tab 页 + 自定义顶栏（menu 钮/标题+周副标题/胶囊占位） | `TabView` index tab；`.toolbar { ToolbarItem(.navigation) menu }` + `principal` 标题副标题组（§3） |
| `contentPaddingTopRpx()` 手算状态栏避让 | 整段删除（safe area 自动，§2.1） |
| 周历条 `wx:for="{{weekDays}}"` + 今日高亮 | `HStack { ForEach(weekDays) { DayCell(item) } }`，`isToday` → `.background(Capsule().fill(.accent))` |
| 条件卡片：`wx:if={{todayActivities.length}}` / `{{workout}}` / `{{nutrition}}` / empty-card | ViewBuilder if/else + 复用 `EmptyCard` 组件 |
| 强度柱状图：`style="height:{{pct}}%; flex-grow:{{weight}}"` | `HStack(alignment:.bottom) { ForEach(bars) { Rectangle().frame(height: pct*maxH).frame(maxWidth:.infinity.weight) } }` —— flex-grow → `layoutPriority` 或 `frame(maxWidth:.infinity)` + weight 比例用 `Grid`/自定义 `Layout`；简单做法 `GeometryReader` 按比例宽 |
| `open-type="share"` 今日卡分享（仅自建课，`data-share="today"` 分支 onShareAppMessage） | `if workout.source == .custom { ShareLink(item: shareURL) }`，URL 构造函数同款 query（§8 D-1/D-2） |
| `catchtap` 拦冒泡（手表/更多/分享钮 vs 卡片整体点击） | 内层 `Button` 自动优先，直接嵌套（§1） |
| switchTab 交接教练上下文（storage `setPendingCoachContext` + coach onShow 消费） | `appModel.pendingCoachContext = …; selectedTab = .coach`（§4.2，storage hack 消失） |
| `push-date-sheet` 组件（弹层选项） | `.sheet(isPresented:)` + `PushDateSheet` View（ScrollView + 列表） |
| onShow：tabBar selected 同步 + 静默刷新（切回 tab 重拉课表） | selectedTab 双向绑定（同步消失）；`onChange(of: selectedTab)` + `scenePhase` 组合触发 `fetchWeekSessions`（§6.2） |
| 删除确认 `wx.showModal` + ActionSheet「删除」 | `.confirmationDialog`（§8 D-6/D-7） |
| waitForAuth 后再拉数据 | `Task { await session.ready(); await load() }`（§7） |

### 9.2 pages/activity-detail/activity-detail（深链可达详情页，复杂度：高）

| 该页用到的概念 | SwiftUI 落法 |
|---|---|
| `onLoad(options.labelId)` query 取参 + `canBack` 判断 | `Route.activityDetail(labelId:)` 关联值注入（§4.1）；canBack 消失（§3 path 填根） |
| loading / notFound / 正常 三态 + 错误归并（404/网络同兜底文案） | `switch model.state` 三态 View（§1） |
| 头部指标网格 `metrics`（label/value/unit/color） | `LazyVGrid` 或 HStack 行 ×N，`unit` 小字拼在 value 后 |
| 轨迹地图：`<map>` + polylines（配速/HR/无色三模式分段着色，600 点抽稀、8 点/段渐变）+ markers（起终点 png + 圈号 label）+ `include-points` 视野适配 | SwiftUI `Map`：`MapPolyline`（分段 color）、`Annotation`（起终点图标/圈号徽标）；**坐标直传 WGS-84 原始点，删掉 wgs84ToGcj02**（地图已决）；`MapCameraPosition` 按 fitPoints 设置。着色/抽稀/bin 纯函数（gradient3/lerpColor）原样搬 Swift |
| uCharts 心率/配速曲线 + touch tooltip | Swift Charts `LineMark` + `chartOverlay` 手势 tooltip（§5） |
| 区间条 `hrZones/paceZones`（percent 宽度条 + duration） | `GeometryReader` 内 `Rectangle().frame(width: pct*width)` 或 `Gauge`；两卡并排 |
| 圈速表 `laps`（最快/最慢行高亮、trend_up/down 图标、pace 分钟/秒两段对齐） | `Grid`/`VStack` 行 + `Image(systemName:)` 或沿用导出的 trend SVG（SF Symbols 无完全对等时用资产图） |
| 天气行 icons（device_thermostat 等 svg） | 资产图搬运或 SF Symbols 对应（thermometer/drop/wind） |
| `onColoringChange` 着色切换（重建 polylines） | model 直改 + Map 自动刷新 |
| 顶栏 house 兜底（fail → coach tab） | §3 path 填根策略；兜底按钮如需保留按 §3 |

### 9.3 pages/race-center/strategy/strategy（编辑态深链页，复杂度：高）

| 该页用到的概念 | SwiftUI 落法 |
|---|---|
| 双入口：已保存（GET 列表 + `?target=` 初始选中）/ 草稿（coach 卡片 `takePendingStrategyDraft` storage 一次性交接） | `Route.raceStrategy(id:target:)` + `appModel.pendingStrategyDraft`（take 一次性消费语义保留，§4.2） |
| 版本 pills（`versions` 数组 + active 高亮 + 切换确认丢弃 `wx.showModal`） | `ScrollView(.horizontal) { HStack { ForEach(versions) { pill } } }` + `.confirmationDialog` |
| 就地编辑：input blur 落值 + 重算累计（`patchPaceRow` 路径 setData + dirty） | `TextField` 双向绑定直改 VM 行属性，`.onChange` 重算 cumulativeTime；dirty 在 VM |
| 补给行增删（数组 map/filter + 重排 index） | `ForEach + onMove/onDelete` 或显式加减钮直改数组 |
| 保存/应用/删除三动作（saving/applying/deleting 防重入 + toast 反馈） | VM 布尔态 + Button disable + `.overlay ProgressView`（§8 D-8） |
| 配速卡海报：离屏 canvas → drawPoster（纯命令式，px 坐标）→ tempFilePath → previewImage | `StrategyPosterView`（声明式海报 View）+ `ImageRenderer` 出 UIImage + `fullScreenCover` 预览 + 保存/分享按钮（§5 全流程） |
| `open-type="share"` + onShareAppMessage（版本三 id 只读落地页）/ onShareTimeline | `ShareLink(item: strategyShareURL)`（universal link 带 user/id/version），timeline 渠道降级消失（§8 D-2） |
| 「和教练再聊」：setPendingCoachContext + **reLaunch**（注释明言：switchTab 会闪现宿主 tab，故 reLaunch） | `appModel.pendingCoachContext = kickoff…; appRouter.reset(to: .coachTab)`（§4.2 reLaunch 分解）——iOS 无切换闪烁问题，是否简化为普通 switchTab 由 parity check 定 |
| canBack ? 箭头 : house；onBack fail → coach tab | §3 全局策略 |
| `wx.showToast`/`showModal` ×N | §8 D-5/D-6 |

**结论：三样本页涉及的概念全部被 §1–§8 覆盖，无未映射残留；仅有的成段「无对等」是微信免密登录、朋友圈分享、胶囊菜单、长按保存（§8 已列降级）。**

---

## 10. 附：wx.* API 使用频次盘点（转译工作量证据，2026-10 全库 grep）

`showToast`×100 · `getWindowInfo`×48 · `getSystemInfoSync`×46 · `navigateTo`×31 · `switchTab`×26 · `navigateBack`×23 · `reLaunch`×20 · `setStorageSync`×13 · `getStorageSync`×13 · `showModal`×12 · `removeStorageSync`×12 · `login`×12 · `request`×9（集中 request.ts/SSE/upload 封装内）· `showLoading`×5 · `hideLoading`×5 · `createSelectorQuery`×5（canvas 取节点，§5 消失）· `uploadFile`×4 · `stopPullDownRefresh`×4 · `showActionSheet`×4 · `previewImage`×3 · `canvasToTempFilePath`×3 · `setClipboardData`×2 · `redirectTo`×2 · `pageScrollTo`×2 · `nextTick`×2 · `getRealtimeLogManager`×2 · `chooseMedia`×2 · `setNavigationBarTitle`×1 · `getLaunchOptionsSync`×1 · `getAccountInfoSync`×1 · `downloadFile`×1 · **支付/授权/订阅消息 = 0**。

> `getWindowInfo`/`getSystemInfoSync`（94 处）几乎全是 statusBarHeight/状态栏避让计算——§3 改用系统导航后**整类消失**，是转译中最大的净删减项。

---

*产出：wayfinder 票 #749（2026-10-25）；脚手架就绪后正式落 `running/ios-app/docs/parity/mapping.md`。*
