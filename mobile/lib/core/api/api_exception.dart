/// Typed exception raised by the Dio API layer.
class ApiException implements Exception {
  const ApiException(this.statusCode, this.message, [this.detail]);

  final int statusCode;
  final String message;
  final Object? detail;

  bool get isUnauthorized => statusCode == 401;
  bool get isForbidden => statusCode == 403;
  bool get isNotFound => statusCode == 404;
  bool get isConflict => statusCode == 409;
  bool get isServerError => statusCode >= 500;

  @override
  String toString() => 'ApiException($statusCode): $message';
}
