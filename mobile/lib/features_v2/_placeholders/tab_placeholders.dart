import 'package:flutter/material.dart';

Widget _ph(String name) =>
    Scaffold(body: Center(child: Text('$name placeholder')));

class HomeScreenPlaceholder extends StatelessWidget {
  const HomeScreenPlaceholder({super.key});
  @override
  Widget build(BuildContext context) => _ph('home');
}

class TrainPlaceholderScreen extends StatelessWidget {
  const TrainPlaceholderScreen({super.key});
  @override
  Widget build(BuildContext context) => _ph('train');
}

class HealthOverviewPlaceholder extends StatelessWidget {
  const HealthOverviewPlaceholder({super.key});
  @override
  Widget build(BuildContext context) => _ph('data');
}

class ProfileScreenPlaceholder extends StatelessWidget {
  const ProfileScreenPlaceholder({super.key});
  @override
  Widget build(BuildContext context) => _ph('me');
}

class ActivityDetailPlaceholder extends StatelessWidget {
  const ActivityDetailPlaceholder({required this.activityId, super.key});
  final String activityId;
  @override
  Widget build(BuildContext context) =>
      Scaffold(body: Center(child: Text('activity_detail($activityId) placeholder')));
}
