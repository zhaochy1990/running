import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/router/routes_v2.dart';
import '../../../core/theme/tokens.dart';
import '../../profile/widgets/account_drawer.dart';
import '../widgets/nav_tab.dart';

/// Global key for the shell [Scaffold] so child tab screens (which have their
/// own nested Scaffolds) can open the account drawer via the top-left ≡ button:
/// `shellScaffoldKey.currentState?.openDrawer()`.
final shellScaffoldKey = GlobalKey<ScaffoldState>();

/// Bottom-nav shell hosting **4 equal flat tabs** — 跑者 / 发现 / 数据 / 教练.
///
/// No center FAB. "教练" keeps the accent color even when idle to read as the
/// intelligent core. The "我" surface moved off the bar into [AccountDrawer],
/// opened from the top-left ≡ on each tab.
///
/// Tab indices:
///   0  跑者  /v2/home
///   1  发现  /v2/discover
///   2  数据  /v2/data
///   3  教练  /v2/coach
class MainShellV2 extends StatelessWidget {
  const MainShellV2({required this.child, super.key});

  final Widget child;

  static const _tabs = <_NavTabSpec>[
    _NavTabSpec(RoutesV2.home, Icons.directions_run, '跑者'),
    _NavTabSpec(RoutesV2.discover, Icons.explore_outlined, '发现'),
    _NavTabSpec(RoutesV2.data, Icons.bar_chart, '数据'),
    _NavTabSpec(RoutesV2.coach, Icons.chat_bubble_outline, '教练',
        accentWhenIdle: true),
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
      key: shellScaffoldKey,
      drawer: const AccountDrawer(),
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
  const _NavTabSpec(this.path, this.icon, this.label,
      {this.accentWhenIdle = false});
  final String path;
  final IconData icon;
  final String label;
  final bool accentWhenIdle;
}
