// 登录回跳 redirect 参数（issue #702）：完整 path+query 经 encodeURIComponent
// 后作为 login / onboarding 页的 query 传入，登录成功或 onboarding 完成后
// reLaunch 回目标页。校验 decode 后以 / 开头（单斜杠，// 也拒）、不含 ://，
// 挡外部 URL / 任意 scheme 的 open-redirect。非法或为空返回空串 = 无回跳，走默认落点。
export function sanitizeRedirect(raw: string | undefined | null): string {
  if (!raw) return '';
  try {
    const url = decodeURIComponent(raw);
    return url.startsWith('/') && !url.startsWith('//') && !url.includes('://') ? url : '';
  } catch {
    return '';
  }
}
