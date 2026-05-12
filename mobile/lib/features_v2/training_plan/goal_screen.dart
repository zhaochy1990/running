/// C1 — Training goal screen (fullscreen, no shell).
///
/// Collects goal type, optional race info, weekly training days,
/// available time slots and strength willingness, then POSTs (or PUTs)
/// to /api/users/me/training-goal and navigates to C2 profile screen.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/router/routes_v2.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../_shared/widgets/top_bar.dart';
import 'models/training_goal.dart';

class TrainingGoalScreen extends ConsumerStatefulWidget {
  const TrainingGoalScreen({super.key});

  @override
  ConsumerState<TrainingGoalScreen> createState() => _TrainingGoalScreenState();
}

class _TrainingGoalScreenState extends ConsumerState<TrainingGoalScreen> {
  GoalType? _goalType;
  DateTime? _raceDate;
  RaceDistance? _raceDistance;
  final _targetTimeCtrl = TextEditingController(); // H:MM:SS
  int _weeklyDays = 4;
  final Set<TimeSlot> _timeSlots = {};
  StrengthWillingness? _strength;

  bool _loading = false;
  String? _error;

  // Existing goal (fetched on init for PUT vs POST decision)
  TrainingGoal? _existing;

  @override
  void initState() {
    super.initState();
    _loadExisting();
  }

  Future<void> _loadExisting() async {
    try {
      final api = ref.read(strideApiProvider);
      final existing = await api.getTrainingGoal();
      if (existing != null && mounted) {
        setState(() {
          _existing = existing;
          _goalType = existing.type;
          _raceDate = existing.raceDate;
          _raceDistance = existing.raceDistance;
          _targetTimeCtrl.text = existing.targetFinishTime ?? '';
          _weeklyDays = existing.weeklyTrainingDays;
          _timeSlots
            ..clear()
            ..addAll(existing.availableTimeSlots);
          _strength = existing.strengthWillingness;
        });
      }
    } catch (_) {
      // ignore — treat as new
    }
  }

  @override
  void dispose() {
    _targetTimeCtrl.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      _goalType != null &&
      _timeSlots.isNotEmpty &&
      _strength != null &&
      (_goalType != GoalType.race || _raceDistance != null);

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final goal = TrainingGoal(
        goalId: _existing?.goalId,
        type: _goalType!,
        raceDate: _raceDate,
        raceDistance: _raceDistance,
        targetFinishTime: _targetTimeCtrl.text.trim().isEmpty
            ? null
            : _targetTimeCtrl.text.trim(),
        weeklyTrainingDays: _weeklyDays,
        availableTimeSlots: _timeSlots.toList(),
        strengthWillingness: _strength!,
      );
      final api = ref.read(strideApiProvider);
      if (_existing != null) {
        await api.putTrainingGoal(goal.toJson());
      } else {
        await api.postTrainingGoal(goal.toJson());
      }
      if (mounted) context.push(RoutesV2.trainingPlanProfile);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: const StrideTopBar(title: '训练目标'),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(StrideTokens.spaceXl),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _sectionLabel('目标类型'),
                    const SizedBox(height: StrideTokens.spaceMd),
                    _GoalTypeGrid(
                      selected: _goalType,
                      onChanged: (t) => setState(() {
                        _goalType = t;
                        // clear race fields when switching away
                        if (t != GoalType.race) {
                          _raceDate = null;
                          _raceDistance = null;
                          _targetTimeCtrl.clear();
                        }
                      }),
                    ),
                    if (_goalType == GoalType.race) ...[
                      const SizedBox(height: StrideTokens.spaceXl),
                      _sectionLabel('比赛信息'),
                      const SizedBox(height: StrideTokens.spaceMd),
                      _RaceFields(
                        raceDate: _raceDate,
                        raceDistance: _raceDistance,
                        targetTimeCtrl: _targetTimeCtrl,
                        onDateChanged: (d) => setState(() => _raceDate = d),
                        onDistanceChanged: (d) =>
                            setState(() => _raceDistance = d),
                      ),
                    ],
                    const SizedBox(height: StrideTokens.spaceXl),
                    _sectionLabel('每周训练天数'),
                    const SizedBox(height: StrideTokens.spaceSm),
                    Row(
                      children: [
                        Text(
                          '$_weeklyDays 天',
                          style: const TextStyle(
                            fontFamily: AppTypography.fontMono,
                            fontSize: StrideTokens.fs15,
                            color: StrideTokens.fg,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Expanded(
                          child: Slider(
                            value: _weeklyDays.toDouble(),
                            min: 3,
                            max: 6,
                            divisions: 3,
                            activeColor: StrideTokens.accent,
                            inactiveColor: StrideTokens.border2,
                            onChanged: (v) =>
                                setState(() => _weeklyDays = v.round()),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: StrideTokens.spaceXl),
                    _sectionLabel('可训练时段（多选）'),
                    const SizedBox(height: StrideTokens.spaceMd),
                    _TimeSlotChips(
                      selected: _timeSlots,
                      onChanged: (slot, checked) {
                        setState(() {
                          if (checked) {
                            _timeSlots.add(slot);
                          } else {
                            _timeSlots.remove(slot);
                          }
                        });
                      },
                    ),
                    const SizedBox(height: StrideTokens.spaceXl),
                    _sectionLabel('力量训练意愿'),
                    const SizedBox(height: StrideTokens.spaceMd),
                    _StrengthSegControl(
                      selected: _strength,
                      onChanged: (v) => setState(() => _strength = v),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: StrideTokens.spaceMd),
                      Text(
                        _error!,
                        style: const TextStyle(
                          fontFamily: AppTypography.fontSans,
                          fontSize: StrideTokens.fs13,
                          color: StrideTokens.danger,
                        ),
                      ),
                    ],
                    const SizedBox(height: StrideTokens.space2xl),
                  ],
                ),
              ),
            ),
            _BottomBar(
              enabled: _canSubmit && !_loading,
              loading: _loading,
              onTap: _submit,
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionLabel(String text) {
    return Text(
      text,
      style: const TextStyle(
        fontFamily: AppTypography.fontSans,
        fontSize: StrideTokens.fs13,
        fontWeight: FontWeight.w600,
        color: StrideTokens.muted,
        letterSpacing: 0.4,
      ),
    );
  }
}

// ── Goal type grid ────────────────────────────────────────────────────────────

const _kGoalLabels = {
  GoalType.race: ('备赛', Icons.emoji_events_outlined),
  GoalType.pb: ('PB 突破', Icons.speed_outlined),
  GoalType.fatLoss: ('减脂塑形', Icons.fitness_center_outlined),
  GoalType.health: ('健康跑', Icons.favorite_border),
  GoalType.maintain: ('维持状态', Icons.loop),
};

class _GoalTypeGrid extends StatelessWidget {
  const _GoalTypeGrid({required this.selected, required this.onChanged});

  final GoalType? selected;
  final void Function(GoalType) onChanged;

  @override
  Widget build(BuildContext context) {
    const types = GoalType.values;
    return Wrap(
      spacing: StrideTokens.spaceMd,
      runSpacing: StrideTokens.spaceMd,
      children: types.map((t) {
        final (label, icon) = _kGoalLabels[t]!;
        final isSelected = selected == t;
        return GestureDetector(
          onTap: () => onChanged(t),
          child: Container(
            width: (MediaQuery.of(context).size.width - 48 - StrideTokens.spaceMd) / 2,
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceMd,
              vertical: StrideTokens.spaceLg,
            ),
            decoration: BoxDecoration(
              color: isSelected ? StrideTokens.accentFg : StrideTokens.surface,
              border: Border.all(
                color: isSelected ? StrideTokens.accent : StrideTokens.border,
                width: isSelected ? 1.5 : 1,
              ),
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            ),
            child: Row(
              children: [
                Icon(
                  icon,
                  size: 20,
                  color: isSelected ? StrideTokens.accent : StrideTokens.muted,
                ),
                const SizedBox(width: StrideTokens.spaceSm),
                Text(
                  label,
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
                    color: isSelected ? StrideTokens.accent : StrideTokens.fg,
                  ),
                ),
              ],
            ),
          ),
        );
      }).toList(),
    );
  }
}

// ── Race fields ───────────────────────────────────────────────────────────────

class _RaceFields extends StatelessWidget {
  const _RaceFields({
    required this.raceDate,
    required this.raceDistance,
    required this.targetTimeCtrl,
    required this.onDateChanged,
    required this.onDistanceChanged,
  });

  final DateTime? raceDate;
  final RaceDistance? raceDistance;
  final TextEditingController targetTimeCtrl;
  final void Function(DateTime?) onDateChanged;
  final void Function(RaceDistance?) onDistanceChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Date picker
        GestureDetector(
          onTap: () async {
            final picked = await showDatePicker(
              context: context,
              initialDate:
                  raceDate ?? DateTime.now().add(const Duration(days: 90)),
              firstDate: DateTime.now(),
              lastDate: DateTime.now().add(const Duration(days: 730)),
              builder: (ctx, child) => Theme(
                data: Theme.of(ctx).copyWith(
                  colorScheme: const ColorScheme.light(
                    primary: StrideTokens.accent,
                  ),
                ),
                child: child!,
              ),
            );
            onDateChanged(picked);
          },
          child: Container(
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceMd,
              vertical: StrideTokens.spaceMd,
            ),
            decoration: BoxDecoration(
              color: StrideTokens.surface,
              border: Border.all(color: StrideTokens.border2),
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            ),
            child: Row(
              children: [
                const Icon(Icons.calendar_today_outlined,
                    size: 16, color: StrideTokens.muted),
                const SizedBox(width: StrideTokens.spaceSm),
                Text(
                  raceDate != null
                      ? '${raceDate!.year}-${raceDate!.month.toString().padLeft(2, '0')}-${raceDate!.day.toString().padLeft(2, '0')}'
                      : '选择比赛日期',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    color: raceDate != null
                        ? StrideTokens.fg
                        : StrideTokens.muted,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        // Distance radio group
        Wrap(
          spacing: StrideTokens.spaceSm,
          runSpacing: StrideTokens.spaceSm,
          children: RaceDistance.values.map((d) {
            final label = switch (d) {
              RaceDistance.fiveK => '5K',
              RaceDistance.tenK => '10K',
              RaceDistance.halfMarathon => '半马',
              RaceDistance.fullMarathon => '全马',
              RaceDistance.trail => '越野',
            };
            final sel = raceDistance == d;
            return ChoiceChip(
              label: Text(
                label,
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs13,
                  color: sel ? StrideTokens.accent : StrideTokens.fg,
                  fontWeight: sel ? FontWeight.w600 : FontWeight.w400,
                ),
              ),
              selected: sel,
              selectedColor: StrideTokens.accentFg,
              backgroundColor: StrideTokens.surface,
              side: BorderSide(
                color: sel ? StrideTokens.accent : StrideTokens.border,
              ),
              onSelected: (_) => onDistanceChanged(d),
              showCheckmark: false,
            );
          }).toList(),
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        // Target time
        TextField(
          controller: targetTimeCtrl,
          keyboardType: TextInputType.datetime,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[0-9:]')),
          ],
          style: const TextStyle(
            fontFamily: AppTypography.fontMono,
            fontSize: StrideTokens.fs14,
            color: StrideTokens.fg,
          ),
          decoration: InputDecoration(
            hintText: '目标成绩 H:MM:SS（可选）',
            hintStyle: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs14,
              color: StrideTokens.muted,
            ),
            filled: true,
            fillColor: StrideTokens.surface,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
              borderSide: const BorderSide(color: StrideTokens.border2),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
              borderSide: const BorderSide(color: StrideTokens.border2),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
              borderSide: const BorderSide(color: StrideTokens.accent),
            ),
            contentPadding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceMd,
              vertical: StrideTokens.spaceMd,
            ),
          ),
        ),
      ],
    );
  }
}

// ── Time slot chips ───────────────────────────────────────────────────────────

const _kSlotLabels = {
  TimeSlot.morning: '早晨',
  TimeSlot.noon: '午间',
  TimeSlot.evening: '晚上',
};

class _TimeSlotChips extends StatelessWidget {
  const _TimeSlotChips(
      {required this.selected, required this.onChanged});

  final Set<TimeSlot> selected;
  final void Function(TimeSlot, bool) onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: StrideTokens.spaceSm,
      children: TimeSlot.values.map((s) {
        final sel = selected.contains(s);
        return FilterChip(
          label: Text(
            _kSlotLabels[s]!,
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              color: sel ? StrideTokens.accent : StrideTokens.fg,
              fontWeight: sel ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
          selected: sel,
          selectedColor: StrideTokens.accentFg,
          backgroundColor: StrideTokens.surface,
          side: BorderSide(
            color: sel ? StrideTokens.accent : StrideTokens.border,
          ),
          showCheckmark: false,
          onSelected: (v) => onChanged(s, v),
        );
      }).toList(),
    );
  }
}

// ── Strength seg control ──────────────────────────────────────────────────────

class _StrengthSegControl extends StatelessWidget {
  const _StrengthSegControl(
      {required this.selected, required this.onChanged});

  final StrengthWillingness? selected;
  final void Function(StrengthWillingness) onChanged;

  @override
  Widget build(BuildContext context) {
    const options = [
      (StrengthWillingness.yes, '愿意'),
      (StrengthWillingness.no, '不愿意'),
      (StrengthWillingness.conditional, '看情况'),
    ];
    return Row(
      children: options.map((pair) {
        final (value, label) = pair;
        final sel = selected == value;
        return Expanded(
          child: GestureDetector(
            onTap: () => onChanged(value),
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 2),
              padding: const EdgeInsets.symmetric(
                vertical: StrideTokens.spaceSm,
              ),
              decoration: BoxDecoration(
                color: sel ? StrideTokens.accent : StrideTokens.surface,
                border: Border.all(
                  color: sel ? StrideTokens.accent : StrideTokens.border,
                ),
                borderRadius: BorderRadius.circular(StrideTokens.radiusSm),
              ),
              child: Center(
                child: Text(
                  label,
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs13,
                    fontWeight: sel ? FontWeight.w600 : FontWeight.w400,
                    color: sel ? StrideTokens.surface : StrideTokens.fg,
                  ),
                ),
              ),
            ),
          ),
        );
      }).toList(),
    );
  }
}

// ── Bottom bar ────────────────────────────────────────────────────────────────

class _BottomBar extends StatelessWidget {
  const _BottomBar(
      {required this.enabled, required this.loading, required this.onTap});

  final bool enabled;
  final bool loading;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(
        StrideTokens.spaceXl,
        StrideTokens.spaceMd,
        StrideTokens.spaceXl,
        StrideTokens.spaceMd + MediaQuery.of(context).padding.bottom,
      ),
      decoration: const BoxDecoration(
        color: StrideTokens.bg,
        border: Border(top: BorderSide(color: StrideTokens.border2)),
      ),
      child: SizedBox(
        width: double.infinity,
        height: 48,
        child: ElevatedButton(
          onPressed: enabled ? onTap : null,
          style: ElevatedButton.styleFrom(
            backgroundColor: StrideTokens.accent,
            disabledBackgroundColor: StrideTokens.border2,
            foregroundColor: StrideTokens.surface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            ),
          ),
          child: loading
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: StrideTokens.surface,
                  ),
                )
              : const Text(
                  '下一步',
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
        ),
      ),
    );
  }
}
