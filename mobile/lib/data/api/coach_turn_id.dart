int _coachTurnSequence = 0;

/// Generates an opaque token accepted by the Coach API's
/// `[A-Za-z0-9_-]{1,128}` idempotency-key contract.
String createCoachClientTurnId() {
  _coachTurnSequence += 1;
  final micros = DateTime.now().microsecondsSinceEpoch;
  return 'mobile-$micros-$_coachTurnSequence';
}
