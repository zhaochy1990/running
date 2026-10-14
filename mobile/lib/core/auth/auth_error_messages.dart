/// auth-service 错误码 → 中文文案（stride-devops#419 决议）。
///
/// auth-service 的错误体是 `{error, message}`（机器码 + 服务端英文描述），
/// 机器码全集来自 Go 侧 `internal/apperror`。客户端只按 `error` 映射中文；
/// 映射不认识的码回落到服务端 message，再回落到通用文案。
library;

const Map<String, String> _kAuthErrorMessages = {
  // SMS 验证码（/api/auth/sms/send + /api/auth/sms/verify）
  'sms_code_invalid': '验证码错误，请重试',
  'sms_code_expired': '验证码已过期，请重新获取',
  'sms_attempts_exceeded': '尝试次数过多，请重新获取验证码',
  'sms_send_cooldown': '操作过于频繁，请 1 分钟后再试',
  'sms_daily_limit': '今日验证码发送次数已达上限，请明天再试',
  'sms_not_configured': '短信服务暂不可用，请稍后再试',
  'sms_provider_error': '短信发送失败，请稍后再试',

  // 手机号（绑定/解绑面；登录页只会碰到 phone_not_registered）
  'phone_not_registered': '该手机号尚未注册',
  'phone_already_bound': '该手机号已绑定其他账号',
  'phone_not_bound': '该手机号未绑定',

  // 登录族
  'invalid_credentials': '邮箱或密码错误',
  'user_disabled': '账号已被停用，请联系客服',
  'invalid_invite_code': '邀请码无效',
  'invite_code_already_used': '邀请码已被使用',
  'service_unavailable': '服务暂时不可用，请稍后再试',

  // refresh 族（会话失效）
  'invalid_token': '登录已过期，请重新登录',
  'token_revoked': '登录已失效，请重新登录',
  'refresh_token_expired': '登录已过期，请重新登录',
};

/// 把 auth-service 的错误信息翻译成给用户看的中文。
///
/// [code] 是错误体里的 `error` 机器码；[server] 是 `message` 原文（兜底展示，
/// 覆盖未来新增但尚未进表的码）。
String authErrorMessage(String? code, {String? server}) {
  final mapped = code == null ? null : _kAuthErrorMessages[code];
  if (mapped != null) return mapped;
  final serverTrimmed = server?.trim();
  if (serverTrimmed != null && serverTrimmed.isNotEmpty) return serverTrimmed;
  return '操作失败，请稍后再试';
}
