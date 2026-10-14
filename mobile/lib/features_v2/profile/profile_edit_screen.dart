/// 个人资料编辑 /me/profile-edit —— 镜像小程序 pages/profile-edit（#414 路由表 9）。
///
/// 数据分库（ADR 0013）：
///   - 身份字段（头像/昵称/邮箱）走 auth-service GET/PATCH /api/users/me
///     + POST /api/users/me/avatar（multipart → COS，≤2MB）；
///   - 身体字段（性别/生日/身高/体重/跑步年限）走数据面
///     GET /api/users/me/profile，已建档逐字段 PATCH、未建档整表 POST。
library;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/auth/auth_user_client.dart';
import '../../core/theme/app_typography.dart';
import '../../core/theme/tokens.dart';
import '../../data/api/stride_api.dart';
import '../../data/models/profile.dart';
import '../_shared/widgets/top_bar.dart';

/// 展示与 VALUES 提交分离（Go oneof：中文标签直接 422），同 onboarding。
const _sexOptions = ['男', '女', '其他'];
const _sexValues = ['male', 'female', 'other'];
const _ageOptions = ['暂不透露', '不足 6 个月', '6 个月 – 1 年', '1 – 3 年', '3 年以上'];
const _ageValues = ['unknown', 'lt_6m', '6m_1y', '1y_3y', '3y_plus'];

class ProfileEditScreen extends ConsumerStatefulWidget {
  const ProfileEditScreen({super.key});

  @override
  ConsumerState<ProfileEditScreen> createState() => _ProfileEditScreenState();
}

class _ProfileEditScreenState extends ConsumerState<ProfileEditScreen> {
  final _nameCtrl = TextEditingController();
  final _heightCtrl = TextEditingController();
  final _weightCtrl = TextEditingController();

  AuthUserProfile? _identity;
  Map<String, dynamic>? _bodyProfile; // 数据面 profile（null = 未建档）
  String? _sex;
  String? _dob;
  String? _ageRange;
  bool _loading = true;
  bool _savingBody = false;
  bool _uploadingAvatar = false;
  String? _error;
  String? _bodyError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _heightCtrl.dispose();
    _weightCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      // 身份与身体分库并行取；任一失败都进错误态（数据可重试）。
      final results = await Future.wait([
        ref.read(authUserClientProvider).getMe(),
        ref.read(strideApiProvider).getMyProfile(),
      ]);
      final identity = results[0] as AuthUserProfile;
      final myProfile = results[1] as MyProfile;
      final body = myProfile.profile;
      if (!mounted) return;
      setState(() {
        _identity = identity;
        _nameCtrl.text = identity.name ?? '';
        _bodyProfile = body;
        _sex = body?['sex'] as String?;
        _dob = body?['dob'] as String?;
        _ageRange = body?['running_age_range'] as String?;
        _heightCtrl.text = _numText(body?['height_cm']);
        _weightCtrl.text = _numText(body?['weight_kg']);
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = '加载失败，请检查网络后重试';
        _loading = false;
      });
    }
  }

  static String _numText(Object? v) =>
      v == null ? '' : (v is num ? v.toString() : v.toString());

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }

  // ── 身份字段（auth-service） ────────────────────────────────────────────

  Future<void> _pickAndUploadAvatar() async {
    if (_uploadingAvatar) return;
    final XFile? picked;
    try {
      picked = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1024,
        maxHeight: 1024,
        imageQuality: 85,
      );
    } catch (_) {
      _toast('无法打开相册');
      return;
    }
    if (picked == null) return;
    setState(() => _uploadingAvatar = true);
    try {
      final url = await ref
          .read(authUserClientProvider)
          .uploadAvatar(picked.path, picked.name);
      if (!mounted) return;
      setState(() {
        _identity = _identity?.copyWith(avatarUrl: url);
        _uploadingAvatar = false;
      });
      _toast('头像已更新');
    } catch (_) {
      if (!mounted) return;
      setState(() => _uploadingAvatar = false);
      _toast('头像上传失败（需 ≤2MB 图片）');
    }
  }

  Future<void> _saveName() async {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty || name == (_identity?.name ?? '')) return;
    try {
      final updated = await ref.read(authUserClientProvider).updateName(name);
      if (!mounted) return;
      setState(() => _identity = updated);
      _toast('昵称已保存');
    } on DioException {
      _toast('昵称保存失败');
    } catch (_) {
      _toast('昵称保存失败');
    }
  }

  // ── 身体字段（数据面） ─────────────────────────────────────────────────

  Future<void> _saveBody() async {
    if (_savingBody) return;
    final height = double.tryParse(_heightCtrl.text.trim());
    final weight = double.tryParse(_weightCtrl.text.trim());
    final displayName = (_identity?.name?.isNotEmpty ?? false)
        ? _identity!.name!
        : (_identity?.email ?? '跑者');
    setState(() {
      _savingBody = true;
      _bodyError = null;
    });
    try {
      final api = ref.read(strideApiProvider);
      if (_bodyProfile != null) {
        await api.patchProfile(
          sex: _sex,
          dob: _dob,
          heightCm: height,
          weightKg: weight,
          runningAgeRange: _ageRange,
        );
      } else {
        // 未建档走整表 POST（六个字段全必填，Go profileInput）。
        await api.postProfile(
          displayName: displayName,
          dob: _dob ?? '1970-01-01',
          sex: _sex ?? 'other',
          heightCm: height ?? 0,
          weightKg: weight ?? 0,
          runningAgeRange: _ageRange ?? 'unknown',
        );
      }
      if (!mounted) return;
      setState(() {
        _savingBody = false;
        _bodyProfile ??= <String, dynamic>{};
      });
      _toast('身体数据已保存');
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _savingBody = false;
        _bodyError = _friendlyBodyError(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _savingBody = false);
      _toast('保存失败，请稍后重试');
    }
  }

  static String _friendlyBodyError(DioException e) {
    final data = e.response?.data;
    if (data is Map) {
      final detail = data['detail'];
      if (detail is String && detail.isNotEmpty) return detail;
      final code = data['code'];
      if (code is String && code.isNotEmpty) return code;
    }
    return '身体数据未保存完整：性别/生日/身高/体重/跑步年限都要填';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: StrideTokens.bg,
      appBar: StrideTopBar(
        title: '个人资料',
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new, size: 18),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_error!,
                          style: const TextStyle(
                              fontFamily: AppTypography.fontSans,
                              fontSize: StrideTokens.fs14,
                              color: StrideTokens.muted)),
                      const SizedBox(height: StrideTokens.spaceMd),
                      TextButton(onPressed: _load, child: const Text('重试')),
                    ],
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(StrideTokens.spaceLg),
                  children: [
                    _hero(),
                    const SizedBox(height: StrideTokens.spaceLg),
                    _identityCard(),
                    const SizedBox(height: StrideTokens.spaceLg),
                    _bodyCard(),
                    const SizedBox(height: StrideTokens.space3xl),
                  ],
                ),
    );
  }

  // ── 头像 hero ──────────────────────────────────────────────────────────

  Widget _hero() {
    final avatar = _identity?.avatarUrl;
    return Column(
      children: [
        Stack(
          alignment: Alignment.center,
          children: [
            InkWell(
              key: const Key('avatar-tap'),
              onTap: _pickAndUploadAvatar,
              customBorder: const CircleBorder(),
              child: CircleAvatar(
                radius: 44,
                backgroundColor: StrideTokens.accent,
                backgroundImage:
                    avatar == null ? null : NetworkImage(avatar),
                child: avatar == null
                    ? const Icon(Icons.person, size: 40, color: Colors.white)
                    : null,
              ),
            ),
            if (_uploadingAvatar)
              const CircularProgressIndicator(),
          ],
        ),
        const SizedBox(height: StrideTokens.spaceSm),
        Text(
          _uploadingAvatar ? '上传中…' : '点击更换头像',
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.muted,
          ),
        ),
      ],
    );
  }

  // ── 身份字段卡 ─────────────────────────────────────────────────────────

  Widget _identityCard() {
    return _card(children: [
      _rowLabel('昵称'),
      TextField(
        key: const Key('profile-edit-name'),
        controller: _nameCtrl,
        onSubmitted: (_) => _saveName(),
        style: _inputStyle,
        decoration: _inputDecoration(hint: '怎么称呼你'),
      ),
      const SizedBox(height: StrideTokens.spaceMd),
      TextButton(
        key: const Key('profile-edit-name-save'),
        onPressed: _saveName,
        child: const Text('保存昵称'),
      ),
      _divider(),
      _rowLabel('邮箱'),
      Text(
        (_identity?.email?.isNotEmpty ?? false) ? _identity!.email! : '未绑定',
        style: TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs15,
          color: (_identity?.email?.isNotEmpty ?? false)
              ? StrideTokens.fg
              : StrideTokens.muted2,
        ),
      ),
    ]);
  }

  // ── 身体字段卡 ─────────────────────────────────────────────────────────

  Widget _bodyCard() {
    return _card(children: [
      const Text(
        '身体数据',
        style: TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs14,
          fontWeight: FontWeight.w700,
          color: StrideTokens.fg,
        ),
      ),
      const SizedBox(height: StrideTokens.spaceSm),
      const Text(
        '用于训练强度与健康建议',
        style: TextStyle(
          fontFamily: AppTypography.fontSans,
          fontSize: StrideTokens.fs12,
          color: StrideTokens.muted,
        ),
      ),
      const SizedBox(height: StrideTokens.spaceLg),
      _rowLabel('性别'),
      Wrap(
        spacing: StrideTokens.spaceSm,
        children: [
          for (var i = 0; i < _sexValues.length; i++)
            ChoiceChip(
              key: Key('sex-${_sexValues[i]}'),
              label: Text(_sexOptions[i]),
              selected: _sex == _sexValues[i],
              onSelected: (_) => setState(() => _sex = _sexValues[i]),
            ),
        ],
      ),
      const SizedBox(height: StrideTokens.spaceLg),
      _rowLabel('生日'),
      InkWell(
        key: const Key('dob-tap'),
        onTap: _pickDob,
        borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
        child: InputDecorator(
          decoration: _inputDecoration(hint: '请选择'),
          child: Text(
            _dob ?? '请选择',
            style: TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs15,
              color: _dob == null ? StrideTokens.muted2 : StrideTokens.fg,
            ),
          ),
        ),
      ),
      const SizedBox(height: StrideTokens.spaceLg),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _rowLabel('身高 (cm)'),
                TextField(
                  key: const Key('height-input'),
                  controller: _heightCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  style: _inputStyle,
                  decoration: _inputDecoration(hint: '170'),
                ),
              ],
            ),
          ),
          const SizedBox(width: StrideTokens.spaceMd),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _rowLabel('体重 (kg)'),
                TextField(
                  key: const Key('weight-input'),
                  controller: _weightCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  style: _inputStyle,
                  decoration: _inputDecoration(hint: '65'),
                ),
              ],
            ),
          ),
        ],
      ),
      const SizedBox(height: StrideTokens.spaceLg),
      _rowLabel('跑步年限'),
      DropdownButtonFormField<String>(
        key: const Key('age-range-dropdown'),
        initialValue: _ageRange,
        hint: const Text(
          '请选择',
          style: TextStyle(color: StrideTokens.muted2),
        ),
        items: [
          for (var i = 0; i < _ageOptions.length; i++)
            DropdownMenuItem(
              value: _ageValues[i],
              child: Text(_ageOptions[i]),
            ),
        ],
        onChanged: (v) => setState(() => _ageRange = v),
        decoration: _inputDecoration(hint: '请选择'),
      ),
      if (_bodyError != null) ...[
        const SizedBox(height: StrideTokens.spaceLg),
        Text(
          _bodyError!,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            color: StrideTokens.danger,
          ),
        ),
      ],
      const SizedBox(height: StrideTokens.spaceLg),
      SizedBox(
        width: double.infinity,
        child: FilledButton(
          key: const Key('profile-edit-body-save'),
          style: FilledButton.styleFrom(
            backgroundColor:
                _savingBody ? StrideTokens.muted2 : StrideTokens.accent,
            foregroundColor: Colors.white,
            shape: const StadiumBorder(),
            padding: const EdgeInsets.symmetric(vertical: 12),
          ),
          onPressed: _savingBody ? null : _saveBody,
          child: Text(
            _savingBody ? '保存中…' : '保存身体数据',
            style: const TextStyle(
              fontFamily: AppTypography.fontSans,
              fontSize: StrideTokens.fs13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    ]);
  }

  Future<void> _pickDob() async {
    final now = DateTime.now();
    final initial = DateTime.tryParse(_dob ?? '') ?? DateTime(2000);
    final picked = await showDatePicker(
      context: context,
      initialDate: initial.isBefore(now) ? initial : now,
      firstDate: DateTime(1900),
      lastDate: now,
    );
    if (picked != null) {
      setState(() {
        _dob = '${picked.year.toString().padLeft(4, '0')}-'
            '${picked.month.toString().padLeft(2, '0')}-'
            '${picked.day.toString().padLeft(2, '0')}';
      });
    }
  }

  // ── 小组件 ─────────────────────────────────────────────────────────────

  Widget _card({required List<Widget> children}) => Container(
        padding: const EdgeInsets.all(StrideTokens.spaceLg),
        decoration: BoxDecoration(
          color: StrideTokens.surface,
          border: Border.all(color: StrideTokens.border),
          borderRadius: BorderRadius.circular(StrideTokens.radiusLg),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      );

  Widget _rowLabel(String text) => Padding(
        padding: const EdgeInsets.only(bottom: StrideTokens.spaceSm),
        child: Text(
          text,
          style: const TextStyle(
            fontFamily: AppTypography.fontSans,
            fontSize: StrideTokens.fs12,
            fontWeight: FontWeight.w600,
            color: StrideTokens.fgSoft,
            letterSpacing: 0.5,
          ),
        ),
      );

  Widget _divider() => const Padding(
        padding: EdgeInsets.symmetric(vertical: StrideTokens.spaceMd),
        child: Divider(height: 1, color: StrideTokens.border),
      );

  static const _inputStyle = TextStyle(
    fontFamily: AppTypography.fontSans,
    fontSize: StrideTokens.fs15,
    color: StrideTokens.fg,
  );

  InputDecoration _inputDecoration({required String hint}) {
    final border = OutlineInputBorder(
      borderSide: const BorderSide(color: StrideTokens.border),
      borderRadius: BorderRadius.circular(StrideTokens.radiusMd),
    );
    return InputDecoration(
      hintText: hint,
      hintStyle: const TextStyle(
        color: StrideTokens.muted2,
        fontSize: StrideTokens.fs14,
      ),
      filled: true,
      fillColor: StrideTokens.surface,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: StrideTokens.spaceMd,
        vertical: StrideTokens.spaceMd,
      ),
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(
        borderSide: const BorderSide(color: StrideTokens.accent),
      ),
    );
  }
}
