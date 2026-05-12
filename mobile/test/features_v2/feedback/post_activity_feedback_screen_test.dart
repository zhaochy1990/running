import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/core/auth/current_user.dart';
import 'package:stride/data/api/stride_api.dart';
import 'package:stride/features_v2/feedback/models/activity_feedback.dart';
import 'package:stride/features_v2/feedback/post_activity_feedback_screen.dart';

// ── Fake StrideApi ────────────────────────────────────────────────────────────

class _FakeApi implements StrideApi {
  _FakeApi({bool shouldFail = false}) : _shouldFail = shouldFail;

  final bool _shouldFail;
  bool putCalled = false;

  @override
  Future<ActivityFeedback> putActivityFeedback({
    required String userId,
    required String labelId,
    required int rpe,
    required List<String> moodTags,
    String? note,
  }) async {
    putCalled = true;
    if (_shouldFail) throw Exception('网络错误');
    return ActivityFeedback(
      labelId: labelId,
      rpe: rpe,
      moodTags: moodTags,
      note: note,
    );
  }

  @override
  Future<ActivityFeedback> getActivityFeedback(
    String userId,
    String labelId,
  ) async {
    return ActivityFeedback(labelId: labelId);
  }

  // All other StrideApi members not used — delegate to noSuchMethod.
  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError(i.memberName.toString());
}

// ── Pump helper ───────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester, {
  String labelId = 'ACT_001',
  String? activityName,
  _FakeApi? api,
}) async {
  final fakeApi = api ?? _FakeApi();

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        currentUserIdProvider.overrideWithValue('user-001'),
        strideApiProvider.overrideWithValue(fakeApi),
      ],
      child: MaterialApp(
        home: PostActivityFeedbackScreen(
          labelId: labelId,
          activityName: activityName,
        ),
      ),
    ),
  );
  await tester.pump();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  group('PostActivityFeedbackScreen', () {
    testWidgets('default rpe=0: submit button is disabled', (tester) async {
      // Use a very tall surface so everything renders without scrolling.
      await tester.binding.setSurfaceSize(const Size(390, 1400));
      await _pump(tester, activityName: '晨跑 10K');
      await tester.pump();

      final elevated = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(elevated.onPressed, isNull,
          reason: 'Submit must be disabled when rpe == 0');
    });

    testWidgets('slider updates rpe display and enables submit', (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 1400));
      await _pump(tester, activityName: '晨跑 10K');

      // Move slider to a non-zero value.
      final slider = find.byType(Slider);
      expect(slider, findsOneWidget);
      await tester.drag(slider, const Offset(100, 0));
      await tester.pump();

      final btn = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(btn.onPressed, isNotNull,
          reason: 'Submit must be enabled after setting a valid rpe');
    });

    testWidgets('selecting 5 tags works; 6th tag is rejected with SnackBar',
        (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 1400));
      await _pump(tester);

      // Tap 5 tags.
      for (final tag in ['腿酸', '状态好', '天气热', '天气冷', '心情好']) {
        await tester.tap(find.text(tag));
        await tester.pump();
      }

      // Tap a 6th tag.
      await tester.tap(find.text('心情差'));
      await tester.pump();

      // SnackBar "最多选 5 个" should appear.
      expect(find.text('最多选 5 个'), findsOneWidget,
          reason: 'Selecting a 6th tag should show an error snack-bar');
    });

    testWidgets('note field has maxLength 200', (tester) async {
      // Tall surface so all content renders without scrolling.
      await tester.binding.setSurfaceSize(const Size(390, 1400));
      await _pump(tester);
      await tester.pump();

      // The note field is the first TextField (the counter sub-widget may add
      // more; find.first picks the outermost one we created).
      final tf = tester.widget<TextField>(find.byType(TextField).first);
      expect(tf.maxLength, 200);
    });

    testWidgets('activity name card renders when provided', (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 1400));
      await _pump(tester, activityName: '节奏跑 16K');

      expect(find.text('节奏跑 16K'), findsOneWidget);
    });

    testWidgets('top bar shows "训练反馈" title', (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 1400));
      await _pump(tester);
      expect(find.text('训练反馈'), findsOneWidget);
    });

    testWidgets('all 10 mood tag options are visible', (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 1400));
      await _pump(tester);

      for (final tag in [
        '腿酸', '状态好', '天气热', '天气冷',
        '心情好', '心情差', '睡眠不足', '节奏好',
        '气喘吁吁', '完成度高',
      ]) {
        expect(find.text(tag), findsOneWidget, reason: 'Tag "$tag" not found');
      }
    });
  });
}
