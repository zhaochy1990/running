import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Stream of the device's current connectivity. We treat
/// only `[ConnectivityResult.none]` as offline; any other
/// result (wifi, mobile, ethernet, vpn, bluetooth) is online.
final connectivityProvider = StreamProvider<bool>((ref) async* {
  final c = Connectivity();
  yield _online(await c.checkConnectivity());
  yield* c.onConnectivityChanged.map(_online);
});

bool _online(List<ConnectivityResult> results) {
  if (results.isEmpty) return false;
  return !results.every((r) => r == ConnectivityResult.none);
}
