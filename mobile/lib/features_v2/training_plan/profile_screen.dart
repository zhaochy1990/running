/// C2 — Running profile screen (fullscreen, no shell).
///
/// Collects running age, weekly km, PBs (optional) and injury history,
/// then POSTs to /api/users/me/running-profile and navigates to C3
/// history sync. Has a "跳过" button that skips directly to C3.
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
import 'models/running_profile.dart';

// ── Injury tags ───────────────────────────────────────────────────────────────

const _kInjuryOptions = [
  '暂无',
  '膝盖',
  '脚踝',
  '髂胫束',
  '跟腱',
  '足底筋膜',
  '髋部',
  '腰背',
];

// ── Screen ────────────────────────────────────────────────────────────────────

class RunningProfileScreen extends ConsumerStatefulWidget {
  const RunningProfileScreen({super.key});

  @override
  ConsumerState<RunningProfileScreen> createState() =>
      _RunningProfileScreenState();
}

class _RunningProfileScreenState extends ConsumerState<RunningProfileScreen> {
  RunningAge? _runningAge;
  WeeklyKm? _weeklyKm;

  // PB controllers: 5K / 10K / HM / FM
  final _pb5kCtrl = TextEditingController();
  final _pb10kCtrl = TextEditingController();
  final _pbHmCtrl = TextEditingController();
  final _pbFmCtrl = TextEditingController();

  // injuries: 'none' maps to empty list; otherwise the selected tags
  final Set<String> _injuries = {};

  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _pb5kCtrl.dispose();
    _pb10kCtrl.dispose();
    _pbHmCtrl.dispose();
    _pbFmCtrl.dispose();
    super.dispose();
  }

  List<Map<String, String>> _parsePbEntries() {
    final entries = <Map<String, String>>[];
    void add(String dist, String raw) {
      final t = raw.trim();
      if (t.isNotEmpty) entries.add({'distance': dist, 'time': t});
    }

    add('5K', _pb5kCtrl.text);
    add('10K', _pb10kCtrl.text);
    add('HM', _pbHmCtrl.text);
    add('FM', _pbFmCtrl.text);
    return entries;
  }

  List<String> get _injuryList {
    if (_injuries.contains('暂无')) return [];
    return _injuries.toList();
  }

  Future<void> _submit() async {
    if (_runningAge == null || _weeklyKm == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final pbEntries = _parsePbEntries();
      final body = RunningProfile(
        runningAge: _runningAge!,
        currentWeeklyKm: _weeklyKm!,
        pbs: pbEntries
            .map((e) => PB(distance: e['distance']!, time: e['time']!))
            .toList(),
        injuries: _injuryList,
      ).toJson();
      await ref.read(strideApiProvider).postRunningProfile(body);
      if (mounted) context.push(RoutesV2.trainingPlanHistorySync);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _skip() {
    context.push(RoutesV2.trainingPlanHistorySync);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '跑步背景',
        actions: [
          TextButton(
            onPressed: _skip,
            child: const Text(
              '跳过',
              style: TextStyle(
                fontFamily: AppTypography.fontSans,
                fontSize: StrideTokens.fs13,
                color: StrideTokens.muted,
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(StrideTokens.spaceXl),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _sectionLabel('跑龄'),
                    const SizedBox(height: StrideTokens.spaceMd),
                    _RadioGroup<RunningAge>(
                      options: const [
                        (RunningAge.lt6m, '不足 6 个月'),
                        (RunningAge.sixMonthsTo1Year, '6 个月 ~ 1 年'),
                        (RunningAge.oneToThreeYears, '1 ~ 3 年'),
                        (RunningAge.threePlus, '3 年以上'),
                      ],
                      selected: _runningAge,
                      onChanged: (v) => setState(() => _runningAge = v),
                    ),
                    const SizedBox(height: StrideTokens.spaceXl),
                    _sectionLabel('目前周跑量'),
                    const SizedBox(height: StrideTokens.spaceMd),
                    _RadioGroup<WeeklyKm>(
                      options: const [
                        (WeeklyKm.lt20, '< 20 km'),
                        (WeeklyKm.twentyToForty, '20 ~ 40 km'),
                        (WeeklyKm.fortyToSixty, '40 ~ 60 km'),
                        (WeeklyKm.sixtyPlus, '60 km+'),
                      ],
                      selected: _weeklyKm,
                      onChanged: (v) => setState(() => _weeklyKm = v),
                    ),
                    const SizedBox(height: StrideTokens.spaceXl),
                    _sectionLabel('个人 PB（可选，H:MM:SS）'),
                    const SizedBox(height: StrideTokens.spaceMd),
                    _PbFields(
                      ctrl5k: _pb5kCtrl,
                      ctrl10k: _pb10kCtrl,
                      ctrlHm: _pbHmCtrl,
                      ctrlFm: _pbFmCtrl,
                    ),
                    const SizedBox(height: StrideTokens.spaceXl),
                    _sectionLabel('伤病史（多选）'),
                    const SizedBox(height: StrideTokens.spaceMd),
                    _InjuryChips(
                      selected: _injuries,
                      onChanged: (tag, checked) {
                        setState(() {
                          if (tag == '暂无') {
                            if (checked) {
                              _injuries
                                ..clear()
                                ..add('暂无');
                            } else {
                              _injuries.remove('暂无');
                            }
                          } else {
                            if (checked) {
                              _injuries
                                ..remove('暂无')
                                ..add(tag);
                            } else {
                              _injuries.remove(tag);
                            }
                          }
                        });
                      },
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
              enabled: _runningAge != null && _weeklyKm != null && !_loading,
              loading: _loading,
              onNext: _submit,
              onSkip: _skip,
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

// ── Radio group ───────────────────────────────────────────────────────────────

class _RadioGroup<T> extends StatelessWidget {
  const _RadioGroup({
    required this.options,
    required this.selected,
    required this.onChanged,
  });

  final List<(T, String)> options;
  final T? selected;
  final void Function(T) onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: options.map((pair) {
        final (value, label) = pair;
        final sel = selected == value;
        return GestureDetector(
          onTap: () => onChanged(value),
          child: Container(
            margin: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
            padding: const EdgeInsets.symmetric(
              horizontal: StrideTokens.spaceMd,
              vertical: StrideTokens.spaceMd,
            ),
            decoration: BoxDecoration(
              color: sel ? StrideTokens.accentFg : StrideTokens.surface,
              border: Border.all(
                color: sel ? StrideTokens.accent : StrideTokens.border,
                width: sel ? 1.5 : 1,
              ),
              borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
            ),
            child: Row(
              children: [
                Icon(
                  sel
                      ? Icons.radio_button_checked
                      : Icons.radio_button_off,
                  size: 18,
                  color: sel ? StrideTokens.accent : StrideTokens.muted,
                ),
                const SizedBox(width: StrideTokens.spaceSm),
                Text(
                  label,
                  style: TextStyle(
                    fontFamily: AppTypography.fontSans,
                    fontSize: StrideTokens.fs14,
                    fontWeight: sel ? FontWeight.w600 : FontWeight.w400,
                    color: sel ? StrideTokens.accent : StrideTokens.fg,
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

// ── PB fields ─────────────────────────────────────────────────────────────────

class _PbFields extends StatelessWidget {
  const _PbFields({
    required this.ctrl5k,
    required this.ctrl10k,
    required this.ctrlHm,
    required this.ctrlFm,
  });

  final TextEditingController ctrl5k;
  final TextEditingController ctrl10k;
  final TextEditingController ctrlHm;
  final TextEditingController ctrlFm;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          children: [
            Expanded(child: _pbField('5K', ctrl5k)),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(child: _pbField('10K', ctrl10k)),
          ],
        ),
        const SizedBox(height: StrideTokens.spaceMd),
        Row(
          children: [
            Expanded(child: _pbField('半马', ctrlHm)),
            const SizedBox(width: StrideTokens.spaceMd),
            Expanded(child: _pbField('全马', ctrlFm)),
          ],
        ),
      ],
    );
  }

  Widget _pbField(String label, TextEditingController ctrl) {
    return TextField(
      controller: ctrl,
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
        labelText: label,
        hintText: 'H:MM:SS',
        labelStyle: const TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs13,
          color: StrideTokens.muted,
        ),
        hintStyle: const TextStyle(
          fontFamily: AppTypography.fontMono,
          fontSize: StrideTokens.fs13,
          color: StrideTokens.muted2,
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
          vertical: StrideTokens.spaceSm,
        ),
      ),
    );
  }
}

// ── Injury chips ──────────────────────────────────────────────────────────────

class _InjuryChips extends StatelessWidget {
  const _InjuryChips({required this.selected, required this.onChanged});

  final Set<String> selected;
  final void Function(String tag, bool checked) onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: StrideTokens.spaceSm,
      runSpacing: StrideTokens.spaceSm,
      children: _kInjuryOptions.map((tag) {
        final sel = selected.contains(tag);
        return FilterChip(
          label: Text(
            tag,
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
          onSelected: (v) => onChanged(tag, v),
        );
      }).toList(),
    );
  }
}

// ── Bottom bar ────────────────────────────────────────────────────────────────

class _BottomBar extends StatelessWidget {
  const _BottomBar({
    required this.enabled,
    required this.loading,
    required this.onNext,
    required this.onSkip,
  });

  final bool enabled;
  final bool loading;
  final VoidCallback onNext;
  final VoidCallback onSkip;

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
      child: Row(
        children: [
          Expanded(
            child: OutlinedButton(
              onPressed: onSkip,
              style: OutlinedButton.styleFrom(
                foregroundColor: StrideTokens.muted,
                side: const BorderSide(color: StrideTokens.border),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                ),
                minimumSize: const Size.fromHeight(48),
              ),
              child: const Text(
                '跳过',
                style: TextStyle(
                  fontFamily: AppTypography.fontSans,
                  fontSize: StrideTokens.fs15,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ),
          const SizedBox(width: StrideTokens.spaceMd),
          Expanded(
            flex: 2,
            child: ElevatedButton(
              onPressed: enabled ? onNext : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: StrideTokens.accent,
                disabledBackgroundColor: StrideTokens.border2,
                foregroundColor: StrideTokens.surface,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
                ),
                minimumSize: const Size.fromHeight(48),
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
        ],
      ),
    );
  }
}
