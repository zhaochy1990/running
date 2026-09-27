# 规则

1. 不要在本包之外重建 LLM client。`src/llm/models.ts` 是唯一一处把 `ModelConfig` 变成 LangChain 模型的地方 —— endpoint、鉴权、思考开关、Responses / Chat Completions 的分发都只在这里。在别处再写一份 `new ChatOpenAI(...)` 就是这个包存在的理由被绕过了。
2. 不要为了测试方便，往 `buildModel` 或 `StructuredRequest` 上开注入口（注入 client 构造器之类）。e2e 用真实供应商，单测用真实的 `StructuredRunnable` 假对象，两条路都不需要这种缝。

# 改 `src/llm/models.ts` 必须跑 e2e（HARD）

**任何对 `src/llm/models.ts` 的修改，提交前必须跑：**

```bash
cd src/stride-common && npm run test:e2e
```

理由：单测注入的是假对象，看不见供应商的真实行为 —— 返回的 content 形状、错误的形状、`strict: true` 是否真的约束住了模型。`e2e/models.test.ts` 是唯一能观察到这些的地方。

它已经抓到过两个单测全部放行的缺陷：

- Responses API 返回的 `content` 是 content block 数组，不是字符串；
- 指向不可达 endpoint 的用例，被 OpenAI SDK 自己的重试拖成了 108 秒。

`e2e` 覆盖业务实际在跑的每一种配置：`qa` / `other` 的 chat-completions（思考关）、生产 `qa`（思考开）、规划角色的 responses、master plan 图六个模型用的结构化路径，以及 `validate` 的接受 / 改写 / 拒绝。**其中最后两条最关键** —— `graph/master_plan/nodes.ts` 靠 `ModelContractError` 区分「质量问题（永不重试）」和「基础设施问题（值得重试）」，包错错误类型会让 worker 反复重试注定失败的任务。所以改动只许包住 decode 失败和 `validate` 失败，其它错误必须原样抛出。

**e2e 的配置写在测试文件里**（`ENDPOINT` / `API_KEY_ENV` / `MODEL`），**不要改成读 `config/coach.yaml`**。读线上配置文件的测试会在配置变动时挂掉，或者更糟 —— 悄悄开始测别的东西。

**代价是手工的**：业务换模型时，必须同步改 `e2e/models.test.ts` 的 `MODEL`。这是刻意的取舍，不是遗漏；不要为了"自动同步"再把它接回配置文件。

e2e 故意不照抄角色的 `max_tokens` 和 `timeout_s`（用 2048 / 60s）：线上角色的 `timeout_s` 最大 600s，一次挂起的调用会把测试拖成十分钟。

e2e 的约定：

- 真实调用需要配置里写的那个 key 环境变量（本地是 `DEEPSEEK_API_KEY`）。**没有 key 时全部 skip 而不是 fail**，这个行为不要改 —— 否则 CI 会被无谓地打红。
- 不要加慢或会 flaky 的用例。指向不可达 host 这类"真实但慢"的用例已经因此被换成供应商侧拒绝（不存在的模型名）：同样的分类语义，87ms 而不是 108s。
- 用例要断言**契约性质**（schema 合法、错误类型、非空回复），不要断言模型的具体措辞。

# Code Style

use biome for code formatter. use `npm run format`, `npm run check` to format and check code styles.

注意 `e2e/` 不在 `src/` 下：库的 `tsconfig.json` 覆盖不到它，Node 的类型剥离也不做类型检查。所以类型检查靠 `tsconfig.e2e.json`（已接进 `test:e2e` 的 `typecheck:e2e` 步骤），而 biome 靠仓库根 `biome.json` 的白名单（已加入 `src/stride-common/e2e/**`）—— 新增目录时别忘了这两处。
