/// Model for GET /api/users/me/master-plan/jobs/{job_id} response.
library;

class MasterPlanJobStatus {

  factory MasterPlanJobStatus.fromJson(Map<String, dynamic> json) {
    return MasterPlanJobStatus(
      jobId: json['job_id'] as String? ?? '',
      status: json['status'] as String? ?? 'pending',
      stage: json['stage'] as String?,
      progress: (json['progress'] as num?)?.toInt() ?? 0,
      stageLabel: json['stage_label'] as String?,
      resultPlanId: json['result_plan_id'] as String?,
      error: json['error'] as String?,
      rawOutput: json['raw_output'] as String?,
      elapsedSeconds: (json['elapsed_seconds'] as num?)?.toInt() ?? 0,
    );
  }
  const MasterPlanJobStatus({
    required this.jobId,
    required this.status,
    this.stage,
    this.progress = 0,
    this.stageLabel,
    this.resultPlanId,
    this.error,
    this.rawOutput,
    this.elapsedSeconds = 0,
  });

  /// 'pending' | 'running' | 'done' | 'failed'
  final String status;
  final String jobId;

  /// Internal stage name e.g. 'analyzing', 'generating', 'validating'
  final String? stage;

  /// 0-100
  final int progress;

  /// Human-readable stage label (already in Chinese from backend)
  final String? stageLabel;

  /// Set when status == 'done'
  final String? resultPlanId;

  /// Set when status == 'failed'
  final String? error;

  /// Raw LLM output for debugging (folded in UI)
  final String? rawOutput;

  final int elapsedSeconds;

  bool get isDone => status == 'done';
  bool get isFailed => status == 'failed';
  bool get isTerminal => isDone || isFailed;

  MasterPlanJobStatus copyWith({
    String? status,
    String? stage,
    int? progress,
    String? stageLabel,
    String? resultPlanId,
    String? error,
    String? rawOutput,
    int? elapsedSeconds,
  }) {
    return MasterPlanJobStatus(
      jobId: jobId,
      status: status ?? this.status,
      stage: stage ?? this.stage,
      progress: progress ?? this.progress,
      stageLabel: stageLabel ?? this.stageLabel,
      resultPlanId: resultPlanId ?? this.resultPlanId,
      error: error ?? this.error,
      rawOutput: rawOutput ?? this.rawOutput,
      elapsedSeconds: elapsedSeconds ?? this.elapsedSeconds,
    );
  }
}
