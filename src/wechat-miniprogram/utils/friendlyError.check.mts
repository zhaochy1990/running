/**
 * friendlyError 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/friendlyError.check.mts`。
 *
 * 契约重点：
 * 1. 英文错误（服务端透传 / wx 网络层 errMsg / ApiError）绝不透传给用户，一律兜底中文；
 * 2. 已是中文的 message（本地哨兵「同步超时」、auth 服务已映射文案）原样放行；
 * 3. 绑表 400 按状态定制文案（后端防账号枚举把 provider 认证失败塌缩成 400）。
 */
import { friendlyApiError, friendlyMessage } from './friendlyError.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// 与 services/request.ts ApiError 同形（name='ApiError' + statusCode），见
// friendlyError.ts 文件头「为什么不直接 import」。
class ApiErrorStub extends Error {
  statusCode: number;
  constructor(status: number) {
    super('Request failed with status ' + status);
    this.name = 'ApiError';
    this.statusCode = status;
  }
}

const apiErr = (status: number, _body: Record<string, unknown>) => new ApiErrorStub(status);

// —— ApiError：英文服务端消息一律兜底，不透传 ——
eq(
  friendlyApiError(apiErr(400, { error: 'bad request', detail: 'invalid dob' }), '保存失败，请重试'),
  '保存失败，请重试',
  'ApiError 400 falls back (no override)',
);
eq(
  friendlyApiError(apiErr(400, { error: 'Could not authenticate with COROS' }), '绑定失败，请重试', {
    statusMessages: { 400: '手表账号或密码错误，请核对后重试' },
  }),
  '手表账号或密码错误，请核对后重试',
  'ApiError 400 status override (watch bind)',
);
eq(
  friendlyApiError(apiErr(500, { error: 'internal error' }), '同步失败，请重试'),
  '同步失败，请重试',
  'ApiError 5xx falls back',
);

// —— 网络层失败：固定网络文案 ——
eq(
  friendlyApiError(new Error('request:fail timeout'), '加载失败，请稍后重试'),
  '网络异常，请检查网络后重试',
  'network failure message',
);
eq(
  friendlyApiError(new Error('request:fail '), '加载失败'),
  '网络异常，请检查网络后重试',
  'network failure empty errMsg',
);

// —— 中文 message 原样放行（哨兵 / 已映射文案） ——
eq(friendlyApiError(new Error('同步超时'), '同步失败'), '同步超时', 'Chinese sentinel passes through');
eq(
  friendlyApiError(new Error('邮箱或密码错误'), '登录失败，请重试'),
  '邮箱或密码错误',
  'already-mapped Chinese passes through',
);

// —— 杂项：无 message / 非 Error ——
eq(friendlyApiError(new Error(''), '保存失败，请重试'), '保存失败，请重试', 'empty message');
eq(friendlyApiError(undefined, '重试失败，请稍后再试'), '重试失败，请稍后再试', 'non-Error value');
eq(friendlyApiError('some string error', '重试失败'), '重试失败', 'plain string error');

// —— friendlyMessage：服务端字符串 ——
eq(friendlyMessage('run failed: fetch activities', '同步失败'), '同步失败', 'English server msg → fallback');
eq(friendlyMessage('第 3 步失败：拉取活动', '同步失败'), '第 3 步失败：拉取活动', 'Chinese server msg passes');
eq(friendlyMessage('', '同步失败，请重试'), '同步失败，请重试', 'empty server msg → fallback');
eq(friendlyMessage(undefined, '同步失败'), '同步失败', 'undefined server msg → fallback');
eq(friendlyMessage('  bad request  ', '同步失败'), '同步失败', 'trimmed English server msg → fallback');

console.log('friendlyError.check.mts: all green');
