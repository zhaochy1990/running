import re

# 1. profile_screen_test：watch subtitle 拆成两个独立 testWidgets（ProviderScope 不可换 overrides）
p = 'test/features_v2/profile/profile_screen_test.dart'
src = open(p).read()
src = src.replace('''  testWidgets('watch subtitle reflects binding state', (tester) async {
    await _pump(tester, profile: _testProfile);
    expect(find.text('已绑定'), findsOneWidget);

    await _pump(
      tester,
      profile: const MyProfile(
        id: 'user-123',
        displayName: 'Test Runner',
        onboarding: OnboardingState(corosReady: false, profileReady: true),
        profile: {'email': 'test@stride.cn'},
      ),
    );
    expect(find.text('未绑定'), findsOneWidget);
  });''', '''  testWidgets('watch subtitle shows 已绑定 when corosReady', (tester) async {
    await _pump(tester, profile: _testProfile);
    expect(find.text('已绑定'), findsOneWidget);
  });

  testWidgets('watch subtitle shows 未绑定 when not bound', (tester) async {
    await _pump(
      tester,
      profile: const MyProfile(
        id: 'user-123',
        displayName: 'Test Runner',
        onboarding: OnboardingState(corosReady: false, profileReady: true),
        profile: {'email': 'test@stride.cn'},
      ),
    );
    expect(find.text('未绑定'), findsOneWidget);
  });''')
open(p, 'w').write(src)

# 2. week_detail_screen_test：删「调整计划」按钮用例（按钮已随 plan chat 死域移除）
p = 'test/features_v2/plan/week_detail_screen_test.dart'
src = open(p).read()
m = re.search(r"  // ── 12\. 调整计划 button is present[^/]*?──[^\n]*\n  testWidgets\('调整计划 button is present'.*?\n  \}\);\n", src, re.S)
assert m, '调整计划 test not found'
src = src[:m.start()] + src[m.end():]
open(p, 'w').write(src)

# 3. week_detail_screen 文档注释同步
p = 'lib/features_v2/plan/week_detail_screen.dart'
src = open(p).read()
src = src.replace('///   5. 底部固定区：调整计划 + 推送到手表（均为 SnackBar 占位）', '///   5. 底部固定区：推送到手表（整周逐课推送 + 结果 sheet）')
src = src.replace('///   1. StrideTopBar：返回 + week 标题 + "调整"按钮（SnackBar 占位）', '///   1. StrideTopBar：返回 + week 标题')
open(p, 'w').write(src)
print('ok')
