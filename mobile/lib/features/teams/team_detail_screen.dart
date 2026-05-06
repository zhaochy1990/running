import 'package:flutter/material.dart';

class TeamDetailScreen extends StatelessWidget {
  const TeamDetailScreen({required this.teamId, super.key});

  final String teamId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('战队 · $teamId')),
      body: const Center(child: Text('S9 待实装')),
    );
  }
}
