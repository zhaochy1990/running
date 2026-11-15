import Foundation

public enum CalibrationMetric: Sendable { case pace, heartRate }

/// Presentation only: consumes server seconds/km and never estimates capability.
public struct CalibrationDisplay: Equatable, Sendable {
    public let value: String
    public let range: String?
    public let support: String
    public let evidenceDay: String?
    public let cutoffDay: String?
    public let computedShanghai: String?
    public let details: [String]
}

public func calibrationDisplay(_ response: StrideZonesResponse?, metric: CalibrationMetric) -> CalibrationDisplay {
    let t = response?.threshold
    let source = t?.source ?? response?.source
    let knownSource = source?.schemaVersion == 1 && source?.state == "available"
    let s = knownSource ? (metric == .pace ? source?.speed : source?.hr) : nil
    let confidence = metric == .pace ? t?.speedConfidence : t?.hrConfidence
    let value = metric == .pace ? calibrationPace(t?.pacePerKmSec) : calibrationNumber(t?.hrBpm)
    let range: String?
    if metric == .pace, let r = t?.speedRangePacePerKmSec {
        switch r.boundKind {
        case "two_sided" where r.fast != nil && r.slow != nil && r.fast! <= r.slow!:
            range = "支持范围 \(calibrationPace(r.fast.map(Double.init)))–\(calibrationPace(r.slow.map(Double.init))) /km"
        case "speed_lower_bound" where r.slow != nil:
            let slow = calibrationPace(r.slow.map(Double.init))
            range = "至少可达到 \(slow) /km（配速 ≤ \(slow)）"
        case "speed_upper_bound" where r.fast != nil:
            range = "配速 ≥ \(calibrationPace(r.fast.map(Double.init))) /km（仅单侧约束）"
        default: range = nil
        }
    } else if metric == .heartRate, let low = s?.rangeLow, let high = s?.rangeHigh, low <= high {
        range = "支持范围 \(calibrationNumber(low))–\(calibrationNumber(high)) bpm"
    } else { range = nil }

    let legacy = source == nil || source?.state == "legacy_source_missing" || s?.method == "legacy_v3_training_estimate"
    let support: String
    if t == nil { support = "暂无估计" }
    else if legacy { support = "旧版支持标签 \(confidence ?? s?.support ?? "未知") · \(s == nil ? "来源信息不可用" : "非独立检测")" }
    else if !knownSource { support = "来源信息不可用" }
    else if s == nil { support = metric == .heartRate ? "心率证据信息未提供" : "配速证据信息未提供" }
    else { support = "能力支持：\(calibrationLevel(s?.support))" }

    let cutoff = [source?.dataCutoffDay, t?.asOfDate].compactMap { $0 }.first { !$0.isEmpty }
    let computed = calibrationExecutionDay(t?.computedAt)
    var details = [metric == .pace
        ? "阈值配速是约一小时全力跑能力的估计，不是日常训练平均配速。仅有约束或全力证据不足时，可以没有中心值。"
        : "阈值心率需结合来源理解；场地心率代理是训练参考，不是生理乳酸阈值。与配速证据相关联的心率不构成独立交叉验证。",
        "支持范围反映证据与模型敏感性，不是统计置信区间。数据质量只描述测量可靠性，不等于全力程度或能力支持。"]
    if let s {
        details.append("方法：\(calibrationMethod(s.method))")
        if metric == .heartRate {
            switch s.targetType {
            case "field_HR_proxy_not_physiological_LTHR": details.append("目标：场地心率代理（非生理乳酸阈值）")
            case "lab_method_specific_LTHR": details.append("目标：实验室方法特定乳酸阈值 · \(s.labMethod ?? "方法未提供")")
            case "legacy_training_estimate", "legacy_training_estimate_not_independent_LTHR": details.append("目标：旧版训练估计，未经独立生理检测")
            case "unavailable": details.append("目标：暂无可用心率参考")
            default: details.append("目标语义未提供或暂不支持")
            }
        }
        details.append("数据质量：\(calibrationQuality(s.measurementQuality))；全力支持：\(calibrationEffort(s.effortSupport))")
        details.append("独立活动 \(s.independentActivities.map(String.init) ?? "未知") 次 · 独立日期 \(s.independentDays.map(String.init) ?? "未知") 天")
        for reason in (s.reasons ?? []) + (s.limitations ?? []) {
            details.append(calibrationReason(reason))
        }
        for evidence in (s.evidence ?? []).prefix(3) {
            var line = "关键来源：\(evidence.activityDay)"
            if let start = evidence.startS, let end = evidence.endS {
                line += " · 片段 \(calibrationNumber(start))–\(calibrationNumber(end)) 秒"
            } else if let duration = evidence.durationS { line += " · 时长 \(calibrationNumber(duration)) 秒" }
            details.append(line + "；摘要可用，活动详情可能已删除或不可访问。")
        }
    } else {
        if t == nil { details.append("尚无可用校准快照；不会用其他版本补造中心值。") }
        else if value == "—" { details.append("尚未形成可用中心估计；证据信息不足时不补造旧值。") }
        else { details.append("来源摘要不可用，保留已有训练估计；不能视为独立检测。") }
    }
    if let selection = t?.selection ?? response?.selection, selection.state == "fallback" {
        details.append("使用回退版本：首选版本缺少历史快照。")
    }
    if let rejectedDay = s?.latestRejectedEvidenceDate { details.append("最近未采用证据日 \(rejectedDay)") }
    details.append("证据日期：\(s?.evidenceDate ?? "未提供")")
    details.append("数据截止：\(cutoff ?? "未提供")")
    details.append("校准执行：\(computed ?? "未提供")（上海时间）；执行日期不代表新增证据。")
    return CalibrationDisplay(value: value, range: range, support: support, evidenceDay: s?.evidenceDate,
                              cutoffDay: cutoff, computedShanghai: computed, details: details)
}

private func calibrationNumber(_ value: Double?) -> String {
    guard let value, value.isFinite, value >= 0, value < Double(Int.max) else { return "—" }
    // HR remains a fractional wire value; use positive ties-up, matching the
    // Web/MP Math.round display contract. Pace has its own server-integer path.
    return Fmt.intStr(value.rounded(.toNearestOrAwayFromZero))
}

private func calibrationPace(_ seconds: Double?) -> String {
    guard let seconds, seconds.isFinite, seconds > 0, seconds < Double(Int.max) else { return "—" }
    return Fmt.pace(seconds.rounded(.toNearestOrEven)).replacingOccurrences(of: "/km", with: "")
}

private func calibrationExecutionDay(_ utc: String?) -> String? {
    guard let utc else { return nil }
    let iso = ISO8601DateFormatter()
    var date = iso.date(from: utc)
    if date == nil { iso.formatOptions.insert(.withFractionalSeconds); date = iso.date(from: utc) }
    guard let date else { return nil }
    let output = DateFormatter()
    output.locale = Locale(identifier: "en_US_POSIX")
    output.timeZone = Shanghai.timeZone
    output.dateFormat = "yyyy-MM-dd HH:mm"
    return output.string(from: date)
}

private func calibrationLevel(_ value: String?) -> String {
    switch value { case "high": "高"; case "medium": "中"; case "low": "低"; case "none", "insufficient": "不足"; default: "未知（保守解读）" }
}

private func calibrationEffort(_ value: String?) -> String {
    switch value { case "confirmed_maximal": "已确认全力"; case "likely_maximal", "probable_maximal": "可能全力"; case "submaximal": "非全力"; default: "未知" }
}

private func calibrationQuality(_ value: String?) -> String {
    value == "protocol_quality_gate_passed" ? "通过协议质量门槛" : calibrationLevel(value)
}

private func calibrationMethod(_ value: String?) -> String {
    switch value {
    case "direct_hour_anchor", "direct_60min_maximal": "约一小时全力锚点"
    case "cross_duration_inference", "speed_duration_inference": "跨时长推断"
    case "constraints_only": "仅约束，未形成中心估计"
    case "insufficient_maximal_support": "全力支持不足，未形成中心估计"
    case "field_test_protocol", "field_30min_last20_v1": "场地测试协议（30分钟测试的后20分钟）"
    case "lab_lthr_report_v1": "实验室乳酸阈值报告"
    case "legacy_training_estimate", "legacy_v3_training_estimate": "旧版训练估计"
    default: "未知方法，保守解读"
    }
}

private func calibrationReason(_ value: String) -> String {
    switch value {
    case "insufficient_maximal_support": "全力证据不足，暂不提升能力支持或补造中心值。"
    case "stale_HR_support", "stale_hr_support": "心率支持已陈旧，等待新的有效证据。"
    case "stale_speed_support", "stale_anchor", "stale_evidence": "配速支持已陈旧，等待新的有效证据。"
    case "research_parameters_not_independently_calibrated": "研究参数尚未完成独立校准。"
    case "legacy_estimate_not_independent_detection": "旧版训练估计，不是独立阈值检测。"
    case "no_independent_maximal_anchors": "缺少独立近全力证据，目前仅能给出能力约束。"
    case "hour_extrapolation_not_identified_by_independent_recent_anchors": "近期独立锚点不足，无法推断一小时能力。"
    case "endurance_exponent_unidentified_research_midpoint": "耐力参数未被证据充分确定，使用研究中点。"
    case "binding_original_duration_constraints_model_inference": "原时长约束影响模型推断，结果属于跨时长估计。"
    case "conflicting_evidence_robust_fit_low_support": "证据存在冲突，已保守降低能力支持。"
    case "no_independent_HR_protocol_support": "缺少独立心率测试协议支持。"
    case "independent_HR_protocol_support": "存在独立心率测试协议支持；不代表与配速独立交叉验证。"
    case "independent_HR_protocols_disagree_over_6_bpm": "心率协议结果分歧超过6 bpm，支持已降低。"
    case "environment_not_corrected": "尚未校正环境影响。"
    case "event_date_only_not_strict_as_known": "按活动日期回顾，不代表当时已知信息的严格重建。"
    case "field_proxy_is_not_physiological_LTHR": "场地心率代理不等于生理乳酸阈值。"
    case "HR_research_quality_parameters_uncalibrated": "心率质量参数尚未完成独立校准。"
    case "missing_cadence_cannot_exclude_cadence_lock": "缺少步频时，无法排除心率与步频锁定。"
    case "range_is_sensitivity_not_95_percent_ci": "范围为敏感性范围，不是统计置信区间。"
    case "power_law_valid_only_180_to_7200s": "跨时长模型仅适用于180–7200秒。"
    case "long_duration_uses_monotone_envelope_not_precise_extrapolation": "长时段仅使用单调边界，不做精确外推。"
    default: "存在其他证据限制，暂按较保守支持解读。"
    }
}
