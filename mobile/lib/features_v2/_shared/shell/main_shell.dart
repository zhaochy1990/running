import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/router/routes_v2.dart';

/// Bottom-nav shell hosting 5 tabs with a center raised "record" button.
///
/// Tab indices:
///   0  首页  /v2/home
///   1  训练  /v2/train
///   2  记录  (center raised button — snackbar only, no nav)
///   3  数据  /v2/data
///   4  我    /v2/me
///
/// TODO(T02): when shared `StrideNavTab` lands, replace inline tab items.
class MainShellV2 extends StatelessWidget {
  const MainShellV2({required this.child, super.key});

  final Widget child;

  static const _navTabs = <_NavTabSpec>[
    _NavTabSpec(RoutesV2.home, Icons.home_outlined, Icons.home, '首页'),
    _NavTabSpec(RoutesV2.train, Icons.show_chart, Icons.show_chart, '训练'),
    _NavTabSpec(null, null, null, '记录'), // center button placeholder slot
    _NavTabSpec(RoutesV2.data, Icons.bar_chart_outlined, Icons.bar_chart, '数据'),
    _NavTabSpec(RoutesV2.me, Icons.person_outline, Icons.person, '我'),
  ];

  int _currentTabIndex(String loc) {
    if (loc.startsWith(RoutesV2.home)) return 0;
    if (loc.startsWith(RoutesV2.train)) return 1;
    if (loc.startsWith(RoutesV2.data)) return 3;
    if (loc.startsWith(RoutesV2.me)) return 4;
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final loc = GoRouterState.of(context).uri.path;
    final currentTabIndex = _currentTabIndex(loc);

    return Scaffold(
      body: child,
      bottomNavigationBar: SafeArea(
        top: false,
        child: SizedBox(
          height: 72,
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.topCenter,
            children: [
              _BottomBar(
                tabs: _navTabs,
                currentTabIndex: currentTabIndex,
                onTap: (i) {
                  if (i == 2) {
                    _showRecordSnack(context);
                    return;
                  }
                  final path = _navTabs[i].path;
                  if (path != null) context.go(path);
                },
              ),
              Positioned(
                top: -16,
                child: _RecordCenterButton(
                  onTap: () => _showRecordSnack(context),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showRecordSnack(BuildContext ctx) {
    ScaffoldMessenger.of(ctx).showSnackBar(
      const SnackBar(content: Text('实时记录 v1.x 即将开放')),
    );
  }
}

class _NavTabSpec {
  const _NavTabSpec(this.path, this.icon, this.iconActive, this.label);
  final String? path;
  final IconData? icon;
  final IconData? iconActive;
  final String label;
}

class _BottomBar extends StatelessWidget {
  const _BottomBar({
    required this.tabs,
    required this.currentTabIndex,
    required this.onTap,
  });
  final List<_NavTabSpec> tabs;
  final int currentTabIndex;
  final void Function(int) onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 72,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border(
          top: BorderSide(color: Theme.of(context).dividerColor, width: 0.5),
        ),
      ),
      child: Row(
        children: [
          for (var i = 0; i < tabs.length; i++)
            Expanded(
              child: _NavItem(
                spec: tabs[i],
                active: i == currentTabIndex,
                isCenterSlot: i == 2,
                onTap: () => onTap(i),
              ),
            ),
        ],
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.spec,
    required this.active,
    required this.isCenterSlot,
    required this.onTap,
  });
  final _NavTabSpec spec;
  final bool active;
  final bool isCenterSlot;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final accent = Theme.of(context).colorScheme.primary;
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    final color = active ? accent : muted;

    return InkWell(
      onTap: onTap,
      child: SizedBox(
        height: 72,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (isCenterSlot)
              const SizedBox(height: 24) // reserve space for floating button
            else
              Icon(active ? spec.iconActive : spec.icon, size: 24, color: color),
            const SizedBox(height: 4),
            Text(
              spec.label,
              style: TextStyle(fontSize: 11, color: color),
            ),
          ],
        ),
      ),
    );
  }
}

class _RecordCenterButton extends StatelessWidget {
  const _RecordCenterButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final accent = Theme.of(context).colorScheme.primary;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 56,
        height: 56,
        decoration: BoxDecoration(
          color: accent,
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: accent.withValues(alpha: 0.4),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: const Icon(
          Icons.radio_button_checked,
          color: Colors.white,
          size: 28,
        ),
      ),
    );
  }
}
