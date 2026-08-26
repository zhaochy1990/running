// 训练负荷 / 健康 wire 类型 —— 与后端 /api/{user}/stride/training-load 响应一致。

export interface StrideTrainingLoadRecord {
  date: string;
  algorithm_version: number;
  training_dose: number | null;
  acute_load: number | null;
  chronic_load: number | null;
  form: number | null;
  load_ratio: number | null;
  coverage_status: string;
  readiness_gate: string | null;
  readiness_reasons: string[];
}

export interface StrideTrainingLoadResponse {
  current: StrideTrainingLoadRecord | null;
  series: StrideTrainingLoadRecord[];
}
