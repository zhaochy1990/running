import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/router/routes.dart';

void main() {
  group('Routes.isPublicPath', () {
    // 声明页（用户协议/隐私政策）登录前也要可读（登录页协议链接的落地页）。
    // 这条测试钉住 redirect 的放行集合，防止未来重构无声收回或扩大。
    test('auth flow and declaration pages are public', () {
      expect(Routes.isPublicPath('/auth/start'), isTrue);
      expect(Routes.isPublicPath('/auth/login'), isTrue);
      expect(Routes.isPublicPath('/declaration/user_agreement'), isTrue);
      expect(Routes.isPublicPath('/declaration/privacy_policy'), isTrue);
    });

    test('everything else requires a session', () {
      expect(Routes.isPublicPath('/training'), isFalse);
      expect(Routes.isPublicPath('/records'), isFalse);
      expect(Routes.isPublicPath('/me'), isFalse);
      expect(Routes.isPublicPath('/v2/home'), isFalse);
      expect(Routes.isPublicPath('/declaration'), isTrue); // 前缀放行，路由表未注册会 404
    });
  });
}
