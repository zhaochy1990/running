import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/router/routes.dart';
import '../../../core/theme/tokens.dart';
import '../widgets/nav_tab.dart';

/// Bottom-nav shell hosting the **four tabs mirroring the miniprogram** —
/// 训练 / 记录 / 教练 / 我 (#414 IA decision).
///
/// No drawer: 「我」 is a tab page now. "教练" keeps the accent color even when
/// idle to read as the intelligent core.
///
/// Tab indices:
///   0  训练  /training
///   1  记录  /records
///   2  教练  /coach
///   3  我    /me
class MainShell extends StatelessWidget {
  const MainShell({required this.child, super.key});

  final Widget child;

  static const _tabs = <_NavTabSpec>[
    _NavTabSpec(Routes.training, Icons.directions_run, '训练'),
    _NavTabSpec(Routes.records, Icons.format_list_bulleted, '记录'),
    _NavTabSpec(
      Routes.coach,
      Icons.chat_bubble_outline,
      '教练',
      accentWhenIdle: true,
    ),
    _NavTabSpec(Routes.me, Icons.person_outline, '我'),
  ];

  int _currentTabIndex(String loc) {
    for (var i = 0; i < _tabs.length; i++) {
      if (loc.startsWith(_tabs[i].path)) return i;
    }
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final loc = GoRouterState.of(context).uri.path;
    final currentTabIndex = _currentTabIndex(loc);

    return Scaffold(
      body: child,
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          color: StrideTokens.surface,
          border: Border(top: BorderSide(color: StrideTokens.border2)),
        ),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: 60,
            child: Row(
              children: [
                for (var i = 0; i < _tabs.length; i++)
                  Expanded(
                    child: StrideNavTab(
                      icon: _tabs[i].icon,
                      label: _tabs[i].label,
                      selected: i == currentTabIndex,
                      accentWhenIdle: _tabs[i].accentWhenIdle,
                      onTap: () {
                        if (i != currentTabIndex) context.go(_tabs[i].path);
                      },
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _NavTabSpec {
  const _NavTabSpec(
    this.path,
    this.icon,
    this.label, {
    this.accentWhenIdle = false,
  });
  final String path;
  final IconData icon;
  final String label;
  final bool accentWhenIdle;
}
