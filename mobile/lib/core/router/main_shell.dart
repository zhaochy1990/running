import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// Bottom-nav shell hosting the 5 main tabs.
///
/// Tab → route table:
///   0  Today   /today
///   1  Health  /health
///   2  Teams   /teams
///   3  Plan    /plan
///   4  Me      /profile
class MainShell extends StatelessWidget {
  const MainShell({required this.child, super.key});

  final Widget child;

  static const _tabs = [
    _Tab('/today', Icons.today_outlined, Icons.today, '今日'),
    _Tab('/health', Icons.favorite_outline, Icons.favorite, '体能'),
    _Tab('/teams', Icons.groups_outlined, Icons.groups, '战队'),
    _Tab('/plan', Icons.calendar_month_outlined, Icons.calendar_month, '计划'),
    _Tab('/profile', Icons.person_outline, Icons.person, '我的'),
  ];

  int _indexOfLocation(String location) {
    for (var i = 0; i < _tabs.length; i++) {
      if (location.startsWith(_tabs[i].path)) return i;
    }
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final location = GoRouterState.of(context).uri.path;
    final selectedIndex = _indexOfLocation(location);

    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: selectedIndex,
        onDestinationSelected: (i) => context.go(_tabs[i].path),
        destinations: [
          for (final t in _tabs)
            NavigationDestination(
              icon: Icon(t.icon),
              selectedIcon: Icon(t.iconActive),
              label: t.label,
            ),
        ],
      ),
    );
  }
}

class _Tab {
  const _Tab(this.path, this.icon, this.iconActive, this.label);

  final String path;
  final IconData icon;
  final IconData iconActive;
  final String label;
}
