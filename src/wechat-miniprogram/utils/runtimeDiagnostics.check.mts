/** 全局诊断日志自检：`node --import ./utils/ts-resolve-hooks.mjs utils/runtimeDiagnostics.check.mts`。 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const entries: Array<{ level: string; args: unknown[] }> = [];
let memoryWarning: ((value: { level?: number }) => void) | undefined;
let loggerThrows = false;
const wxMock = {
  getRealtimeLogManager: () => ({
    error: (...args: unknown[]) => {
      if (loggerThrows) throw new Error('logger unavailable');
      entries.push({ level: 'error', args });
    },
    warn: (...args: unknown[]) => {
      if (loggerThrows) throw new Error('logger unavailable');
      entries.push({ level: 'warn', args });
    },
  }),
  getAccountInfoSync: () => ({ miniProgram: { version: '1.2.3', envVersion: 'release' } }),
  getAppBaseInfo: () => ({ version: '8.0.1', SDKVersion: '3.1.2' }),
  getDeviceInfo: () => ({ platform: 'ios', model: 'iPhone 13', system: 'iOS 17.0' }),
  onMemoryWarning: (callback: typeof memoryWarning) => { memoryWarning = callback; },
  getStorageSync: (_key: string) => null,
  getSystemInfo: ({ success }: { success: (info: object) => void }) => success({}),
};
Object.assign(globalThis, { wx: wxMock, getCurrentPages: () => [{ route: 'pages/coach/coach' }] });

const { installMemoryWarningReporter, reportRuntimeError } = await import('./runtimeDiagnostics.ts');
const secret = 'private-chat-token-example';
reportRuntimeError('error', `RangeError: Maximum call stack size exceeded ${secret}`);
assert.equal(entries[0].level, 'error');
assert.deepEqual(entries[0].args, ['[runtime-diagnostic]', {
  event: 'error', category: 'stack_overflow', frames: [], page: 'pages/coach/coach',
  appVersion: '1.2.3', envVersion: 'release', sdkVersion: '3.1.2', wechatVersion: '8.0.1',
  platform: 'ios', model: 'iPhone 13', system: 'iOS 17.0',
}]);
reportRuntimeError('unhandled_rejection', new Error(`removeListener only takes instances of Function ${secret}`));
assert.equal((entries[1].args[1] as { category: string }).category, 'invalid_listener');
reportRuntimeError('error', new TypeError(secret));
assert.equal((entries[2].args[1] as { category: string }).category, 'type_error');
reportRuntimeError('error', { message: secret, stack: secret });
assert.equal((entries[3].args[1] as { category: string }).category, 'other');
assert.ok(!JSON.stringify(entries).includes(secret), '原始异常内容不能写入日志');

// 只保留固定基础库脚本名及行列，URL / 自定义栈文字不能泄露。
reportRuntimeError('error', `TypeError: ${secret}\n@https://lib/WAServiceMainContext.js:1:846900?token=${secret}`);
assert.deepEqual((entries[4].args[1] as { frames: string[] }).frames, ['WAServiceMainContext.js:1:846900']);
assert.ok(!JSON.stringify(entries).includes(secret));

installMemoryWarningReporter();
assert.ok(memoryWarning, '启动后应注册内存告警监听');
memoryWarning({ level: 10 });
assert.equal(entries[5].level, 'warn');
assert.equal((entries[5].args[1] as { event: string }).event, 'memory_warning');
assert.equal((entries[5].args[1] as { level: number }).level, 10);
memoryWarning({});
assert.equal((entries[6].args[1] as { level: unknown }).level, null, 'iOS 可能没有告警等级');

// 验证真正的 App 生命周期接线，而不是只测试独立日志工具。
let app: {
  onLaunch: (this: { globalData: object; checkAuth: () => void }) => void;
  onError: (error: string) => void;
  onUnhandledRejection: (event: { reason: unknown }) => void;
} | undefined;
const appSource = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
const appJs = ts.transpileModule(appSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
runInNewContext(appJs, {
  exports: {},
  wx: wxMock,
  App: (options: typeof app) => { app = options; },
  require: (name: string) => name === './utils/runtimeDiagnostics'
    ? { installMemoryWarningReporter, reportRuntimeError }
    : {},
});
assert.ok(app);
let authStarted = false;
app.onLaunch.call({ globalData: {}, checkAuth: () => { authStarted = true; } });
assert.equal(authStarted, true);
assert.ok(memoryWarning);
app.onError('RangeError: Maximum call stack size exceeded');
assert.equal((entries.at(-1)?.args[1] as { category: string }).category, 'stack_overflow');
app.onUnhandledRejection({ reason: new TypeError(secret) });
assert.equal((entries.at(-1)?.args[1] as { event: string }).event, 'unhandled_rejection');
assert.ok(!JSON.stringify(entries).includes(secret));

// 微信 API 不可用、页面尚未就绪或日志上报失败时，不得抛出新的错误。
wxMock.getAccountInfoSync = () => { throw new Error(secret); };
wxMock.getAppBaseInfo = () => { throw new Error(secret); };
wxMock.getDeviceInfo = () => { throw new Error(secret); };
Object.assign(globalThis, { getCurrentPages: () => { throw new Error(secret); } });
reportRuntimeError('error', 'unknown');
assert.equal((entries.at(-1)?.args[1] as { page: string }).page, 'unknown');
assert.ok(!JSON.stringify(entries).includes(secret));
loggerThrows = true;
assert.doesNotThrow(() => reportRuntimeError('error', 'unknown'));
assert.doesNotThrow(() => memoryWarning?.({ level: 15 }));
wxMock.onMemoryWarning = () => { throw new Error(secret); };
assert.doesNotThrow(installMemoryWarningReporter);

// 单会话限流，避免异常处理反复触发时日志无限增长。
loggerThrows = false;
for (let i = 0; i < 30; i++) reportRuntimeError('error', 'unknown');
assert.ok(entries.filter((entry) => entry.level === 'error').length <= 20);
for (let i = 0; i < 10; i++) memoryWarning?.({ level: 10 });
assert.ok(entries.filter((entry) => entry.level === 'warn').length <= 5);

// 初始化实时日志管理器本身失败时也必须静默降级。
wxMock.getRealtimeLogManager = () => { throw new Error(secret); };
const fallback = await import('./logger.ts?unavailable');
assert.doesNotThrow(() => fallback.logger.error('safe'));

console.log('runtimeDiagnostics.check: all assertions passed');
