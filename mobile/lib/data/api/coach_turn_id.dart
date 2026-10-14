int _coachTurnSequence = 0;

/// Generates an opaque token accepted by the Coach API's
/// `[A-Za-z0-9_-]{1,128}` idempotency-key contract.
String createCoachClientTurnId() {
  _coachTurnSequence += 1;
  final micros = DateTime.now().microsecondsSinceEpoch;
  return 'flutter-$micros-$_coachTurnSequence';
}

/// Client-generated session id — the server derives the thread as
/// `{user}:coach:{session_id}`; no create API (first chat lands the thread).
/// `flutter-` prefix marks app-originated sessions; legacy `qa-*` / `week-*`
/// sessions keep working via the shared checkpoint store.
String createCoachSessionId() => 'flutter-${DateTime.now().millisecondsSinceEpoch}-$_coachTurnSequence';
