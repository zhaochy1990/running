import type { StrideThreshold } from "../api";
import { shanghaiDate, shanghaiTimeShort } from "./shanghai";

// Display only: pace integers and directed bounds are owned by the Go API.
function pace(value: number | null | undefined): string | null {
  return value != null && Number.isSafeInteger(value) && value > 0 && value <= 86400
    ? `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}` : null;
}
const quality: Record<string, string> = { high: "高", medium: "中", low: "低", none: "不足", unknown: "未知" };
const measurementQuality = { ...quality, protocol_quality_gate_passed: "通过协议质量门槛" } as Record<string, string>;
const effort: Record<string, string> = { confirmed_maximal: "已确认全力", probable_maximal: "可能全力", submaximal: "非全力", unknown: "未知" };
const methods: Record<string, string> = {
  direct_60min_maximal: "一小时全力表现锚点", speed_duration_inference: "跨时长模型推断", insufficient_maximal_support: "缺少近全力支持", legacy_v3_training_estimate: "旧版训练估计，非独立检测值",
  direct_hour_anchor: "一小时表现锚点", direct_60min_anchor: "一小时表现锚点",
  constraints_only: "仅有能力约束，无法可靠估计中心", duration_model: "跨时长模型推断",
  field_30min_last20_v1: "场地测试协议（30分钟测试的后20分钟）", lab_lthr_report_v1: "实验室乳酸阈值报告",
  independent_duration_model: "跨时长模型推断", field_test_protocol: "现场测试协议",
  // evolved-v4 (#993) estimator stamps; plain words, never accuracy claims.
  robust_map_effort_margin_fit: "普通训练模型推断", aged_prior_only: "研究先验（随时间老化）", aged_prior_only_HR: "研究先验（随时间老化）",
  constrained_margin_fit: "受表现下界约束的余量估计", bound_fallback: "表现下界回退估计", long_training_fallback: "长跑宽先验回退估计",
  joint_constrained_hr_fit: "配速与心率联合模型推断", regression_H_c_b_logv: "对数速度回归（尺度不可辨识）", prior_only_R_M_085: "静息/最大心率先验（0.85）",
  measured_reference_median: "实测参考中位数（已核验协议）", joint_map_hr_dynamic_fit: "配速与心率联合模型推断",
  prior_predict_only: "先验预测（窗口内无新增可比证据）", unavailable: "无法估计",
};
// Five-state plain-Chinese labels (#1000). Ordinary-training estimates never
// demand an all-out test first; priors are never dressed up as user measurements.
const estimationStates: Record<string, string> = {
  measured_reference: "实测参考",
  model_estimated: "模型估计 · 基于你的普通训练估计",
  prior_dominated: "先验主导 · 基于研究先验估计",
  stale: "已过期 · 保留历史估计",
  unavailable: "暂无估计",
};
function unavailableSuffix(reasons: string[] | null | undefined, metric: "speed" | "hr"): string {
  const codes = reasons ?? [];
  if (codes.includes("no_valid_running_input")) return "窗口内没有有效跑步输入";
  if (codes.includes("no_HR_series_or_qualified_physiological_prior")) return "没有心率序列，也没有可用的静息心率先验";
  if (codes.includes("inputs_physically_invalid")) return "输入超出物理合理范围";
  if (codes.includes("solver_numerical_failure")) return "求解器数值失败，未能输出估计";
  if (metric === "hr" && codes.includes("HR_series_all_excluded_quality_gates")) return "心率序列全部被质量门槛排除";
  return "未能形成有效估计";
}
function reasonText(code: string): string {
  // evolved-v4 (#993) categorical reasons first so their exact wording wins
  // over the generic legacy-stale catch below.
  if (code === "supporting_evidence_older_than_staleness_window") return "支持证据已超过陈旧窗口";
  if (code === "no_valid_running_input") return "窗口内没有有效跑步输入";
  if (code === "no_HR_series_or_qualified_physiological_prior") return "没有心率序列，也没有可用的静息心率先验";
  if (code === "inputs_physically_invalid") return "输入超出物理合理范围";
  if (code === "current_window_empty_prior_only_aged") return "当前窗口无新证据，仅按先验老化更新";
  if (code === "identifiability_limited_prior_dominated") return "证据不足以区分能力与余量，先验主导";
  if (code === "single_layer_short_or_low_quality_only") return "仅短时、低质量或单层证据，先验主导";
  if (code === "prior_scenarios_move_center_beyond_threshold") return "先验情景对中心影响超过阈值，先验主导";
  if (code === "regression_H_c_b_logv_scale_unidentified") return "心率尺度不可辨识，采用对数速度回归估计";
  if (code === "current_window_empty_stale_audit_estimate") return "当前窗口内无支持，输出为历史（陈旧）估计";
  if (code === "hrmax_input_conflict") return "最大心率输入与实测冲突，已切换估计路径";
  if (code === "no_applicable_duration") return "没有适用时长的跑步证据";
  if (code === "joint_solver_failed") return "联合求解失败，已保留配速单独解";
  if (code === "hr_prediction_out_of_domain") return "心率预测超出适用域，不予发布";
  if (code === "single_activity_no_duration_diversity") return "仅一次活动且时长单一，可辨识性不足";
  if (code === "optical_HR_downweighted_not_excluded") return "光电腕式心率已降权使用（未排除）";
  if (code === "prior_only_HR_estimate") return "心率估计仅来自生理先验";
  if (code === "HR_series_all_excluded_quality_gates") return "心率序列全部被质量门槛排除";
  if (code === "all_admitted_rows_rejected_measurement_quality") return "全部输入被测量质量门槛拒绝";
  if (code === "solver_numerical_failure") return "求解器数值失败，未能输出估计";
  if (code === "prior_share_at_least_half_effective_curvature") return "先验影响占比过半，估计以先验为主";
  if (code === "no_new_comparable_evidence_capability_predict_only") return "无新增可比证据，仅做先验预测";
  if (code === "speed_basis_absent_v60_prior_only") return "缺少配速基准，仅用一小时能力先验";
  if (code === "capability_day_effects_separated_from_trend") return "能力日效应与趋势已分开处理";
  if (code === "model_prediction_not_lab_LTHR") return "模型预测不等于实验室乳酸阈值";
  if (code === "hr_shape_knots_monotone_constraint_required") return "心率形状受单调约束";
  if (code === "cadence_lock_suspected_series_excluded") return "疑似步频锁定的序列已被排除";
  if (code === "terrain_gradient_not_corrected") return "未校正坡度影响";
  if (code === "long_duration_uses_monotone_soft_constraint") return "长时长证据仅作单调软约束";
  if (code === "k_grid_coarsened_large_input") return "大输入量下网格已粗化";
  if (code === "HR_tau_grid_coarsened_large_input") return "大输入量下心率动态网格已粗化";
  if (code.toLowerCase().includes("stale")) return "证据陈旧，需更新有效证据";
  if (["insufficient_maximal_support", "no_maximal_anchor", "no_independent_maximal_anchors"].includes(code)) return "缺少独立近全力证据";
  if (code === "hour_extrapolation_not_identified_by_independent_recent_anchors") return "近期独立锚点不足，无法推断一小时能力";
  if (code === "HR_abrupt_spike_or_recovery") return "心率存在突变或恢复，协议未采用";
  if (code === "HR_sustained_recovery_drop_over_10_bpm") return "心率存在持续恢复下降，协议未采用";
  if (code === "HR_range_suggests_recovery_or_artifact") return "心率范围提示恢复或测量异常，协议未采用";
  if (code === "independent_HR_protocol_support") return "存在独立心率协议支持";
  if (code === "no_independent_HR_protocol_support") return "缺少独立心率协议支持";
  if (code === "research_parameters_not_independently_calibrated") return "研究参数尚未独立校准";
  if (code === "environment_not_corrected") return "未校正环境差异";
  if (code.includes("not_95") || code.includes("sensitivity")) return "范围未经概率校准";
  if (code === "field_proxy_is_not_physiological_LTHR") return "现场代理不等于实验室生理阈值";
  return "存在其他证据限制，谨慎使用";
}
function historicalRejectionText(code: string): string {
  if (code.toLowerCase().includes("stale")) return "协议证据已过期";
  if (["HR_abrupt_spike_or_recovery", "HR_sustained_recovery_drop_over_10_bpm", "HR_range_suggests_recovery_or_artifact"].includes(code)) return reasonText(code).replace("，协议未采用", "");
  return "其他历史协议未采用原因";
}
export interface CalibrationDisplay { value: string; range: string | null; status: string; details: string[]; definition: string }
export function calibrationDisplay(threshold: StrideThreshold | null | undefined, metric: "speed" | "hr"): CalibrationDisplay {
  const source = threshold?.source;
  const knownSource = source?.schema_version === 1 && source?.state === "available";
  const m = knownSource ? source[metric] : undefined;
  const isSpeed = metric === "speed";
  const definition = isSpeed ? "阈值配速估计当前全力可维持约一小时的能力，不是普通训练平均配速。" : "阈值心率需独立的心率质量与持续强度支持，不能用心率反过来独立证明配速。";
  const value = isSpeed ? pace(threshold?.pace_per_km_sec) ?? "—" : threshold?.hr_bpm != null && Number.isFinite(threshold.hr_bpm) && threshold.hr_bpm > 0 && threshold.hr_bpm < 300 ? String(Math.round(threshold.hr_bpm)) : "—";
  let range: string | null = null;
  if (isSpeed) {
    const r = threshold?.speed_range_pace_per_km_sec;
    const fast = pace(r?.fast), slow = pace(r?.slow);
    if (r?.bound_kind === "two_sided" && fast && slow && r.fast! <= r.slow!) range = `支持范围 ${fast}–${slow} /km`;
    else if (r?.bound_kind === "speed_lower_bound" && slow && !fast) range = `至少可达到 ${slow} /km（配速 ≤ ${slow}）`;
    else if (r?.bound_kind === "speed_upper_bound" && fast && !slow) range = `配速 ≥ ${fast} /km（仅单侧约束）`;
  } else if (m?.range_low != null && m.range_high != null && Number.isFinite(m.range_low) && Number.isFinite(m.range_high) && m.range_low > 0 && m.range_high < 300 && m.range_low <= m.range_high) {
    range = `支持范围 ${Math.round(m.range_low)}–${Math.round(m.range_high)} bpm`;
  }
  const details: string[] = [];
  let status = !threshold ? "尚无校准，证据不足" : !m ? "旧版估计 · 来源信息不可用" : `估计支持 ${quality[m.support] ?? "未知"}`;
  if (knownSource && !m) status = isSpeed ? "配速证据信息未提供" : "心率证据信息未提供";
  if (m?.method === "legacy_v3_training_estimate" || threshold?.algorithm_version === 3) status = "旧版训练估计 · 非独立检测值";
  if (source && !knownSource && source.state !== "legacy_source_missing") status = "来源信息暂不可用";
  // Five-state (#993): when the row carries a state it leads the status line;
  // unknown future states degrade conservatively instead of borrowing labels.
  if (m?.state) {
    const base = estimationStates[m.state];
    status = m.state === "unavailable"
      ? `${estimationStates.unavailable} · ${unavailableSuffix(m.reasons, metric)}`
      : base ?? "来源信息暂不可用";
  }
  if (m) {
    details.push(`测量质量 ${measurementQuality[m.measurement_quality] ?? "未知"} · 努力程度 ${effort[m.effort_support] ?? "未知"}`);
    details.push(methods[m.method] ?? (m.method.includes("model") ? "跨时长模型推断" : "估计方法详见服务端证据"));
    if (value === "—") details.push("无法可靠估计中心值");
    if (!isSpeed) {
      if (m.target_type === "lab_method_specific_LTHR") details.push(`实验室方法特定 LTHR · ${m.lab_method || "具体方法未提供"}`);
      else if (m.target_type === "field_HR_proxy_not_physiological_LTHR") details.push("现场心率代理，不是生理乳酸阈值实测");
      else if (m.target_type === "model_HRsteady_at_v60_declared_reference_conditions" || m.target_type === "model_steady_state_HR_at_v60_reference_conditions") {
        // P2-2 (#1000 review): a measured_reference center is the verified
        // protocol median, not a model prediction — never label it as one.
        details.push(m.state === "measured_reference"
          ? "参考条件下预计心率（一小时能力配速）"
          : "模型推算稳态心率（参考条件下的一小时能力配速，不是生理乳酸阈值实测）");
      }
      else if (m.target_type === "unavailable") details.push("心率目标不可用，无法可靠估计");
      else details.push("训练心率估计，不是独立实验室检测值");
    }
    if (!isSpeed && (m.method === "joint_map_hr_dynamic_fit" || m.method === "joint_constrained_hr_fit")) details.push("联合估计，非独立验证");
    details.push(`证据日 ${m.evidence_date || "未提供"}`);
    if (m.latest_stale_evidence_date) details.push(`最近陈旧协议日 ${m.latest_stale_evidence_date}`);
    if (m.latest_rejected_evidence_date && m.latest_rejected_evidence_date !== m.latest_stale_evidence_date) details.push(`最近未采用证据日 ${m.latest_rejected_evidence_date}`);
    details.push(`独立活动 ${m.independent_activities ?? 0} 次 · ${m.independent_days ?? 0} 天`);
    const e = m.evidence?.[0];
    if (e) {
      const duration = e.duration_s != null && Number.isFinite(e.duration_s) && e.duration_s > 0 ? ` · 持续 ${Math.round(e.duration_s)} 秒` : "";
      const segment = e.start_s != null && e.end_s != null && e.end_s >= e.start_s ? ` · 片段 ${Math.round(e.start_s)}–${Math.round(e.end_s)} 秒` : "";
      details.push(`来源 ${e.activity_day}${duration}${segment}`);
      details.push("来源活动仅保留摘要，当前不可直接查看");
    }
      // P2-1 (#1000 review): the same categorical reason can be stamped by both
      // the speed fit and the joint refit; render each distinct text once.
      details.push(...new Set([...(m.reasons ?? []), ...(m.limitations ?? [])].map(reasonText)));
    if (m.rejected_reasons?.length) {
      details.push("未采用历史协议（不参与当前估计）");
      details.push(...new Set(m.rejected_reasons.map(code => `未采用协议：${historicalRejectionText(code)}`)));
    }
  } else if (threshold) {
    details.push(knownSource ? "测量质量与努力程度未提供，无法判断独立支持" : "旧版训练估计，不能视为独立检测值；测量质量与努力程度未提供");
  }
  if (range) details.push("支持／敏感性范围，不代表 95% 置信区间或概率");
  if (threshold) {
    details.push(`数据截止 ${source?.data_cutoff_day || threshold.as_of_date || "未提供"}`);
    const at = threshold.computed_at;
    details.push(`校准执行 ${at && shanghaiDate(at) ? `${shanghaiDate(at)} ${shanghaiTimeShort(at)}（上海）` : "未提供"}`);
    // Per-user effective algorithm (#999/#1000): "current effective" wording —
    // a deployed version is never implied to be enabled for everyone.
    const effectiveVersion = threshold.selection?.effective_version ?? threshold.algorithm_version;
    if (effectiveVersion != null) {
      const revision = source?.algorithm_revision;
      const genericFallback = threshold.selection?.state === "fallback" && threshold.selection.reason !== "override_snapshot_missing";
      details.push(`当前有效算法 v${effectiveVersion}${revision ? ` · 修订 ${revision}` : ""}${genericFallback ? " · 回退选择" : ""}`);
    }
    const override = threshold.selection?.override;
    const overrideMissing = threshold.selection?.reason === "override_snapshot_missing";
    if (override) {
      // The pin stays disclosed even when the pinned row is missing at this
      // date (#999); only then does the wording avoid claiming it is served.
      const identity = `v${override.algorithm_version}${override.algorithm_revision ? `（修订 ${override.algorithm_revision}）` : ""}`;
      details.push(overrideMissing ? `你的选择：${identity}` : `已按你的选择使用 ${identity}`);
    }
    if (overrideMissing) details.push("你选择的版本在该日期无快照，暂用全局有效版本");
    if (source?.availability_semantics === "event_date_retrospective") details.push("按活动日期回看，不保证历史当时可得");
  }
  return { value, range, status, details, definition };
}
