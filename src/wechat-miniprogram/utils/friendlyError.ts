// 用户可见错误文案的统一出口。
//
// 背景：request.ts 的 ApiError.message 直接透传服务端英文（detail/message/
// error 字段），页面 `err instanceof Error ? err.message` 这类写法会把
// "400 bad request" / "Could not authenticate with COROS" 一类的英文原文
// 展示给用户（onboarding 绑表实证）。这里把「能不能给用户看」集中成一个
// 判定，页面一律经 friendlyApiError / friendlyMessage 出文案。
//
// 原则：
//   - 日志归日志：原始 err 由调用方 console.error（或 [http] 层已打完整
//     响应体），排障不看本函数的返回值。
//   - 页面文案归页面：除两个明确信号（网络失败、绑表 400 这类按状态定制）
//     外一律用调用方传入的中文兜底文案，不用通用文案覆盖场景文案。
//   - 已是中文的 message 原样放行：保护本地哨兵（"同步超时"）和上游已经
//     映射过的中文（services/auth.ts 的 toBindError）。
//
// 注意：这里故意不 import services/request 的 ApiError 类（它拖出的
// types/api.ts 里有 TS enum，node 跑自检会炸 strip-only 模式），改用鸭子
// 判定 —— ApiError 构造器固定 this.name='ApiError' + statusCode:number，
// 契约稳定。
//
// 自检：friendlyError.check.mts

const CJK_RE = /[\u4e00-\u9fff]/;

/** ApiError 的鸭子形（见文件头注释，为什么不直接 import）。 */
interface ApiErrorLike extends Error {
  statusCode: number;
}

function isApiError(err: unknown): err is ApiErrorLike {
  return (
    err instanceof Error &&
    err.name === 'ApiError' &&
    typeof (err as Partial<ApiErrorLike>).statusCode === 'number'
  );
}

function hasChinese(s: string): boolean {
  return CJK_RE.test(s);
}

function isNetworkFailure(message: string): boolean {
  // wx.request fail 回调的 errMsg 形如 "request:fail timeout" / "request:fail "
  return /^request:fail/i.test(message);
}

/**
 * 服务端字符串（SyncResult.message / session 视图 error 等）的用户可见化：
 * 空 → 兜底；含中文（服务端业务文案多为中文）→ 原样；英文 → 兜底。
 */
export function friendlyMessage(msg: string | null | undefined, fallback: string): string {
  const t = (msg || '').trim();
  if (!t) return fallback;
  return hasChinese(t) ? t : fallback;
}

/**
 * catch 块里的 err → 用户可见中文文案。
 *
 * @param fallback 场景化中文兜底（必传，最终兜底也是它）
 * @param opts.statusMessages 按 HTTP 状态定制的文案（如绑表 400 →
 *        「手表账号或密码错误…」，后端为防账号枚举把 provider 认证失败
 *        统一塌缩成 400，页面可据状态给准确指引）
 */
export function friendlyApiError(
  err: unknown,
  fallback: string,
  opts?: { statusMessages?: Record<number, string> },
): string {
  if (isApiError(err)) {
    const override = opts?.statusMessages?.[err.statusCode];
    if (override) return override;
    return fallback;
  }
  if (err instanceof Error) {
    const msg = (err.message || '').trim();
    if (!msg) return fallback;
    if (isNetworkFailure(msg)) return '网络异常，请检查网络后重试';
    // 本地中文文案（哨兵/已映射）直接放行；英文（wx errMsg、上游透传）不给用户看
    if (hasChinese(msg)) return msg;
  }
  return fallback;
}
