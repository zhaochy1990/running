/// Pipeline run 模型 — Go `runStateResponse` / `startPipelineResponse` 的客户端镜像。
///
/// 契约（stride-devops#418 端点表）：
///   POST /api/{user}/sync        → {run_id, pipeline_name, deduplicated?}
///   GET  /api/pipelines/{run_id} → {run_id, pipeline_name, status, current_step, steps[]}
///   GET  /api/users/{uid}/pipelines → {pipelines: [...]}（新的在前）
class PipelineStep {
  const PipelineStep({required this.name, required this.status});

  factory PipelineStep.fromJson(Map<String, dynamic> json) => PipelineStep(
    name: json['name'] as String? ?? '',
    status: json['status'] as String? ?? '',
  );

  final String name;
  final String status;
}

class PipelineRun {
  const PipelineRun({
    required this.runId,
    required this.pipelineName,
    required this.status,
    required this.currentStep,
    this.steps = const [],
    this.errorMessage,
  });

  factory PipelineRun.fromJson(Map<String, dynamic> json) => PipelineRun(
    runId: json['run_id'] as String? ?? '',
    pipelineName: json['pipeline_name'] as String? ?? '',
    status: json['status'] as String? ?? '',
    currentStep: (json['current_step'] as num?)?.toInt() ?? 0,
    steps: ((json['steps'] as List?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(PipelineStep.fromJson)
        .toList(growable: false),
    errorMessage: json['error_message'] as String?,
  );

  final String runId;
  final String pipelineName;

  /// queued | running | done | failed
  final String status;
  final int currentStep;
  final List<PipelineStep> steps;
  final String? errorMessage;

  bool get isDone => status == 'done';
  bool get isFailed => status == 'failed';
}

/// POST /api/{user}/sync 响应（202 新建 / 200 deduplicated 复用）。
class TriggerSyncResult {
  const TriggerSyncResult({required this.runId, this.deduplicated = false});

  factory TriggerSyncResult.fromJson(Map<String, dynamic> json) =>
      TriggerSyncResult(
        runId: json['run_id'] as String? ?? '',
        deduplicated: json['deduplicated'] == true,
      );

  final String runId;
  final bool deduplicated;
}
