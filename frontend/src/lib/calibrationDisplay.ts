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
};
function reasonText(code: string): string {
  if (code.toLowerCase().includes("stale")) return "证据陈旧，需更新有效证据";
  if (["insufficient_maximal_support", "no_maximal_anchor", "no_independent_maximal_anchors"].includes(code)) return "缺少独立近全力证据";
  if (code === "hour_extrapolation_not_identified_by_independent_recent_anchors") return "近期独立锚点不足，无法推断一小时能力";
  if (code === "no_independent_HR_protocol_support") return "缺少独立心率协议支持";
  if (code === "research_parameters_not_independently_calibrated") return "研究参数尚未独立校准";
  if (code === "environment_not_corrected") return "未校正环境差异";
  if (code.includes("not_95") || code.includes("sensitivity")) return "范围未经概率校准";
  if (code === "field_proxy_is_not_physiological_LTHR") return "现场代理不等于实验室生理阈值";
  return "存在其他证据限制，谨慎使用";
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
  if (m) {
    details.push(`测量质量 ${measurementQuality[m.measurement_quality] ?? "未知"} · 努力程度 ${effort[m.effort_support] ?? "未知"}`);
    details.push(methods[m.method] ?? (m.method.includes("model") ? "跨时长模型推断" : "估计方法详见服务端证据"));
    if (value === "—") details.push("无法可靠估计中心值");
    if (!isSpeed) {
      if (m.target_type === "lab_method_specific_LTHR") details.push(`实验室方法特定 LTHR · ${m.lab_method || "具体方法未提供"}`);
      else if (m.target_type === "field_HR_proxy_not_physiological_LTHR") details.push("现场心率代理，不是实验室生理 LTHR");
      else if (m.target_type === "unavailable") details.push("心率目标不可用，无法可靠估计");
      else details.push("训练心率估计，不是独立实验室检测值");
    }
    details.push(`证据日 ${m.evidence_date || "未提供"}`);
    if (m.latest_rejected_evidence_date) details.push(`最近未采用证据日 ${m.latest_rejected_evidence_date}`);
    details.push(`独立活动 ${m.independent_activities ?? 0} 次 · ${m.independent_days ?? 0} 天`);
    const e = m.evidence?.[0];
    if (e) {
      const duration = e.duration_s != null && Number.isFinite(e.duration_s) && e.duration_s > 0 ? ` · 持续 ${Math.round(e.duration_s)} 秒` : "";
      const segment = e.start_s != null && e.end_s != null && e.end_s >= e.start_s ? ` · 片段 ${Math.round(e.start_s)}–${Math.round(e.end_s)} 秒` : "";
      details.push(`来源 ${e.activity_day}${duration}${segment}`);
      details.push("来源活动仅保留摘要，当前不可直接查看");
    }
    details.push(...new Set([...(m.reasons ?? []), ...(m.limitations ?? [])].map(reasonText)));
  } else if (threshold) {
    details.push(knownSource ? "测量质量与努力程度未提供，无法判断独立支持" : "旧版训练估计，不能视为独立检测值；测量质量与努力程度未提供");
  }
  if (range) details.push("支持／敏感性范围，不代表 95% 置信区间或概率");
  if (threshold) {
    details.push(`数据截止 ${source?.data_cutoff_day || threshold.as_of_date || "未提供"}`);
    const at = threshold.computed_at;
    details.push(`校准执行 ${at && shanghaiDate(at) ? `${shanghaiDate(at)} ${shanghaiTimeShort(at)}（上海）` : "未提供"}`);
    if (threshold.algorithm_version != null) details.push(`算法版本 v${threshold.algorithm_version}${threshold.selection?.state === "fallback" ? " · 回退选择" : ""}`);
    if (source?.availability_semantics === "event_date_retrospective") details.push("按活动日期回看，不保证历史当时可得");
  }
  return { value, range, status, details, definition };
}
