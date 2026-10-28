/**
 * theme 对账自检：`node --import ./utils/ts-resolve-hooks.mjs utils/theme.check.mts`。
 * 校验 styles/theme.wxss 与 utils/theme.ts 互为镜像：
 *   1. 键名一一对应（--color-bg-sunken ↔ bgSunken），多一方即失败；
 *   2. 同名令牌值相等（hex 归一大小写，rgba 归一空白），不一致即失败。
 * 另校验 custom-tab-bar 本地自持令牌（devops#818）：
 *   3. 文件内每个 var(--color-*) 引用都有本地声明——custom-tab-bar 挂在
 *      page 树外的根级，page{} 令牌继承不可达，缺声明即解析为空（P1 迁移
 *      后整条 tab 透明的事故源头）；
 *   4. 每条本地声明与 theme 值相等（换主题改 theme.wxss/theme.ts 后忘同步
 *      tab-bar 即失败，「改一处」由 CI 兜底而非人工记忆）。
 * 防 wxss / TS 两源漂移（#816；进 CI 的 npm test 链）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { theme } from './theme.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wxss = readFileSync(join(root, 'styles/theme.wxss'), 'utf8');
const tabbarWxss = readFileSync(join(root, 'custom-tab-bar/index.wxss'), 'utf8');

/** --color-bg-sunken → bgSunken */
function tokenToKey(token: string): string {
  return token
    .replace(/^--color-/, '')
    .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function normalize(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

// 解析 theme.wxss page{} 里的 --color-* 定义
const defs = new Map<string, string>();
for (const m of wxss.matchAll(/(--color-[a-z-]+)\s*:\s*([^;]+);/g)) {
  const prev = defs.get(m[1]);
  if (prev !== undefined && prev !== normalize(m[2])) {
    throw new Error(`theme.wxss 令牌 ${m[1]} 重复定义且值不一致：${prev} vs ${normalize(m[2])}`);
  }
  defs.set(m[1], normalize(m[2]));
}

const wxssKeys = new Map<string, string>();
for (const [token, value] of defs) wxssKeys.set(tokenToKey(token), value);

const tsKeys = new Map<string, string>();
for (const [k, v] of Object.entries(theme)) tsKeys.set(k, normalize(String(v)));

function fail(msg: string): never {
  throw new Error(`theme 对账失败：${msg}`);
}

const onlyWxss = [...wxssKeys.keys()].filter((k) => !tsKeys.has(k));
if (onlyWxss.length) fail(`theme.wxss 有而 theme.ts 缺：${onlyWxss.join(', ')}`);

const onlyTs = [...tsKeys.keys()].filter((k) => !wxssKeys.has(k));
if (onlyTs.length) fail(`theme.ts 有而 theme.wxss 缺：${onlyTs.join(', ')}`);

for (const [k, v] of wxssKeys) {
  const t = tsKeys.get(k);
  if (t !== v) fail(`令牌 ${k} 两源不一致：wxss=${v} ts=${t}`);
}

// ── custom-tab-bar 本地自持令牌对账（devops#818） ──
// 解析 .tabbar 内的 --color-* 声明（组件内不应有别处声明，重复且不一致同样报错）
const localDefs = new Map<string, string>();
for (const m of tabbarWxss.matchAll(/(--color-[a-z-]+)\s*:\s*([^;]+);/g)) {
  const prev = localDefs.get(m[1]);
  if (prev !== undefined && prev !== normalize(m[2])) {
    throw new Error(
      `custom-tab-bar 令牌 ${m[1]} 重复定义且值不一致：${prev} vs ${normalize(m[2])}`,
    );
  }
  localDefs.set(m[1], normalize(m[2]));
}

// 断言 3：文件内每个 var(--color-*) 引用都有本地声明（page 树外不可达 page{} 令牌）
const usedTokens = new Set<string>();
for (const m of tabbarWxss.matchAll(/var\((--color-[a-z-]+)\)/g)) usedTokens.add(m[1]);
const missingLocal = [...usedTokens].filter((t) => !localDefs.has(t));
if (missingLocal.length) {
  fail(`custom-tab-bar 引用而未本地自持（根组件令牌不可达，会解析为空）：${missingLocal.join(', ')}`);
}

// 断言 4：每条本地声明与 theme 值相等（换主题须同步 tab-bar，CI 兜底）
for (const [token, v] of localDefs) {
  const t = tsKeys.get(tokenToKey(token));
  if (t === undefined) fail(`custom-tab-bar 本地令牌 ${token} 不在 theme 中`);
  if (t !== v) fail(`custom-tab-bar 本地令牌 ${token} 与主题不一致：local=${v} theme=${t}`);
}

console.log(
  `theme 对账通过：${wxssKeys.size} 个令牌两源一致；custom-tab-bar 自持 ${localDefs.size} 个令牌（引用 ${usedTokens.size} 个）一致`,
);
