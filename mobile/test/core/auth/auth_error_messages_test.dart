import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/auth_error_messages.dart';

void main() {
  group('authErrorMessage', () {
    test('maps every Go-side machine code the login surface can emit', () {
      const expectations = {
        // SMS 六码 + provider_error
        'sms_code_invalid': '验证码错误，请重试',
        'sms_code_expired': '验证码已过期，请重新获取',
        'sms_attempts_exceeded': '尝试次数过多，请重新获取验证码',
        'sms_send_cooldown': '操作过于频繁，请 1 分钟后再试',
        'sms_daily_limit': '今日验证码发送次数已达上限，请明天再试',
        'sms_not_configured': '短信服务暂不可用，请稍后再试',
        'sms_provider_error': '短信发送失败，请稍后再试',
        // phone 三码
        'phone_not_registered': '该手机号尚未注册',
        'phone_already_bound': '该手机号已绑定其他账号',
        'phone_not_bound': '该手机号未绑定',
        // 登录族
        'invalid_credentials': '邮箱或密码错误',
        'user_disabled': '账号已被停用，请联系客服',
        'invalid_invite_code': '邀请码无效',
        'invite_code_already_used': '邀请码已被使用',
        'service_unavailable': '服务暂时不可用，请稍后再试',
        // refresh 族
        'invalid_token': '登录已过期，请重新登录',
        'token_revoked': '登录已失效，请重新登录',
        'refresh_token_expired': '登录已过期，请重新登录',
      };
      expectations.forEach((code, chinese) {
        expect(authErrorMessage(code), chinese, reason: code);
      });
    });

    test('falls back to the server message for unknown codes', () {
      expect(
        authErrorMessage('some_future_code', server: 'Server says no'),
        'Server says no',
      );
    });

    test('blank server message falls through to the generic copy', () {
      expect(authErrorMessage(null, server: '  '), '操作失败，请稍后再试');
      expect(authErrorMessage(null), '操作失败，请稍后再试');
    });
  });
}
