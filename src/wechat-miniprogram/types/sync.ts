// 同步 pipeline 相关类型

export interface TriggerSyncOptions {
  full?: boolean;
  idempotencyKey?: string;
}

export interface TriggerSyncResponse {
  run_id: string;
  pipeline_name: string;
  deduplicated?: boolean;
  error?: string;
}

export interface PipelineStep {
  name: string;
  job_type: string;
  status: string;
  job_id?: string;
}

export interface PipelineRun {
  run_id: string;
  pipeline_name: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  current_step: number;
  steps: PipelineStep[];
  error_message?: string;
}
