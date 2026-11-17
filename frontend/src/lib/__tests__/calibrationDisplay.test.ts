import { describe, expect, it } from "vitest";
import fixture from "../../../../docs/calibration/fixtures/client-display-v1.json";
import { calibrationDisplay } from "../calibrationDisplay";
import type { StrideThreshold } from "../../api";

describe("calibration explanation projection", () => {
  it("uses the server integer pace and preserves range direction and three separate dates", () => {
    const c = fixture.cases[0];
    const display = calibrationDisplay(c.response.threshold as StrideThreshold, "speed");
    expect(display.value).toBe(c.expected.pace);
    expect(display.range).toBe(c.expected.pace_range);
    expect(display.details).toContain("证据日 2026-10-01");
    expect(display.details).toContain("数据截止 2026-11-14");
    expect(display.details).toContain("校准执行 2026-11-15 00:30（上海）");
  });
  it.each(fixture.cases)("preserves $name server values without inventing evidence", (c) => {
    const th = c.response.threshold as StrideThreshold | null;
    const speed = calibrationDisplay(th, "speed");
    const hr = calibrationDisplay(th, "hr");
    expect(speed.value).toBe(c.expected.pace);
    expect(speed.range).toBe(c.expected.pace_range);
    expect(hr.value).toBe(c.expected.hr);
    if ("hr_range" in c.expected) expect(hr.range).toBe(c.expected.hr_range);
    if ("hr_method_label" in c.expected) expect(hr.details.join(" ")).toContain(c.expected.hr_method_label);
    if ("speed_effort_label" in c.expected) expect(speed.details.join(" ")).toContain(c.expected.speed_effort_label);
    if ("lab_method" in c.expected && c.expected.lab_method) expect(hr.details.join(" ")).toContain(c.expected.lab_method);
    if ("rejected_evidence_day" in c.expected) {
      const stale = "stale_evidence_day" in c.expected ? c.expected.stale_evidence_day : undefined;
      if (stale) expect(hr.details).toContain(`最近陈旧协议日 ${stale}`);
      if (c.expected.rejected_evidence_day !== stale) expect(hr.details).toContain(`最近未采用证据日 ${c.expected.rejected_evidence_day}`);
      else expect(hr.details).not.toContain(`最近未采用证据日 ${stale}`);
      expect(hr.details).toContain("未采用历史协议（不参与当前估计）");
      if (stale) expect(hr.details).toContain("未采用协议：协议证据已过期");
      if (c.name === "producer-stale-hr-mixed" || c.name.endsWith("-quality")) expect(hr.details).toContain("未采用协议：心率存在突变或恢复");
      const supported = "current_hr_supported" in c.expected && c.expected.current_hr_supported;
      expect(hr.status).toBe(supported ? "估计支持 低" : "估计支持 不足");
      expect(hr.details).not.toContain("证据陈旧，需更新有效证据");
      if (supported) { expect(hr.value).toBe("170"); expect(hr.details).toContain("证据日 2026-11-14"); }
    }
    if (c.name === "low-stale") expect(hr.details).toContain("证据陈旧，需更新有效证据");
    if (c.name === "constraints-only") expect(speed.details).toContain("无法可靠估计中心值");
    if (c.name === "legacy") expect(hr.details.join(" ")).toContain("不能视为独立检测值");
  });
  it("preserves future-schema centers without borrowing known support", () => {
    const th = fixture.cases.find(c => c.name === "future-source-schema")!.response.threshold as StrideThreshold;
    expect(calibrationDisplay(th, "speed").value).toBe("3:34");
    for (const metric of ["speed", "hr"] as const) {
      const display = calibrationDisplay(th, metric);
      expect(display.status).toBe("来源信息暂不可用");
      expect(display.details.join(" ")).not.toContain("已确认全力");
    }
  });
  it("rejects malformed integer/range values and does not derive a pace from speed", () => {
    const th = structuredClone(fixture.cases[0].response.threshold) as StrideThreshold;
    th.pace_per_km_sec = 214.5;
    th.speed_range_pace_per_km_sec = {fast: 260, slow: 240, meaning: "future", bound_kind: "two_sided"};
    expect(calibrationDisplay(th, "speed").value).toBe("—");
    expect(calibrationDisplay(th, "speed").range).toBeNull();
  });
  it("does not call a current snapshot with absent HR evidence a legacy HR estimate", () => {
    const th = structuredClone(fixture.cases[0].response.threshold) as StrideThreshold;
    delete th.source!.hr;
    th.hr_bpm = null;
    expect(calibrationDisplay(th, "hr").status).toBe("心率证据信息未提供");
    expect(calibrationDisplay(th, "hr").details.join(" ")).not.toContain("旧版训练估计");
  });

  it("explains actual publisher protocol quality and independent-anchor reasons separately from support", () => {
    const th = structuredClone(fixture.cases[0].response.threshold) as StrideThreshold;
    th.source!.hr!.measurement_quality = "protocol_quality_gate_passed";
    th.source!.hr!.support = "low";
    expect(calibrationDisplay(th, "hr").details[0]).toContain("通过协议质量门槛");
    expect(calibrationDisplay(th, "hr").status).toBe("估计支持 低");
    th.source!.speed!.reasons = ["no_independent_maximal_anchors", "hour_extrapolation_not_identified_by_independent_recent_anchors"];
    expect(calibrationDisplay(th, "speed").details).toContain("缺少独立近全力证据");
    expect(calibrationDisplay(th, "speed").details).toContain("近期独立锚点不足，无法推断一小时能力");
  });

  // T6 (#1000): evolved-v4 five states, per-user override disclosure and the
  // effective algorithm line share one set of parity literals with mp/iOS.
  const caseThreshold = (name: string): StrideThreshold => {
    const found = fixture.cases.find(c => c.name === name);
    if (!found || !found.response.threshold) throw new Error(`missing fixture case ${name}`);
    return found.response.threshold as StrideThreshold;
  };
  it.each(fixture.cases)("renders shared state/algorithm/override labels for $name", (c) => {
    const th = c.response.threshold as StrideThreshold | null;
    const e = c.expected as Record<string, string | null | undefined>;
    const speed = calibrationDisplay(th, "speed");
    const hr = calibrationDisplay(th, "hr");
    if (e.pace_state !== undefined) expect(speed.status).toBe(e.pace_state);
    if (e.hr_state !== undefined) expect(hr.status).toBe(e.hr_state);
    if (e.pace_algorithm_label !== undefined) {
      expect(speed.details).toContain(e.pace_algorithm_label);
      expect(hr.details).toContain(e.pace_algorithm_label);
    }
    if (e.override_label !== undefined) {
      expect(speed.details).toContain(e.override_label);
      expect(hr.details).toContain(e.override_label);
    }
    if (e.override_fallback_label !== undefined) {
      expect(speed.details).toContain(e.override_fallback_label);
      expect(hr.details).toContain(e.override_fallback_label);
    }
    if (e.hr_joint_label !== undefined) expect(hr.details).toContain(e.hr_joint_label);
    if (e.hr_proxy_label !== undefined) expect(hr.details).toContain(e.hr_proxy_label);
    if (e.hr_model_target_label !== undefined) expect(hr.details).toContain(e.hr_model_target_label);
    if (e.hr_reference_target_label !== undefined) {
      expect(hr.details).toContain(e.hr_reference_target_label);
      expect(hr.details.join(" ")).not.toContain("模型推算稳态心率");
    }
    // P2-1: a categorical reason may be stamped by both the speed fit and the
    // joint refit; reason/limitation texts must render once each. Evidence
    // source lines are factual lists (same-day entries can legitimately repeat)
    // and are excluded.
    const dedupe = (arr: string[], exclude: string) => {
      const kept = arr.filter(d => d && !d.startsWith(exclude));
      expect(new Set(kept).size).toBe(kept.length);
    };
    dedupe(hr.details, "来源 ");
    dedupe(speed.details, "来源 ");
  });

  it("labels low-evidence model estimates from ordinary training without demanding a test", () => {
    const th = caseThreshold("evolved-low-evidence");
    const speed = calibrationDisplay(th, "speed");
    const hr = calibrationDisplay(th, "hr");
    expect(speed.status).toBe("模型估计 · 基于你的普通训练估计");
    // v4 rev3: without a usable R/M pair the HR walks the §6.4 regression
    // path — an honest prior-dominated model estimate, never a suppression.
    expect(hr.status).toBe("先验主导 · 基于研究先验估计");
    expect(speed.value).toBe("4:49");
    expect(speed.range).toBe("支持范围 4:15–5:03 /km");
    expect(hr.value).toBe("162");
    expect(hr.range).toBe("支持范围 156–168 bpm");
    expect(speed.details.join(" ")).not.toContain("必须先测试");
    expect(hr.details.join(" ")).not.toContain("必须先测试");
    expect(hr.details.join(" ")).toContain("对数速度回归");
    // Non-probabilistic ranges must never claim a 95% CI; the negated
    // disclaimer is the required wording, not a claim.
    expect(speed.range ?? "").not.toContain("95%");
    expect(hr.range ?? "").not.toContain("95%");
    expect(hr.details.join(" ")).toContain("不代表 95% 置信区间或概率");
  });

  it("labels prior-dominated estimates as research priors, never user measurements", () => {
    const th = caseThreshold("evolved-prior-only");
    const speed = calibrationDisplay(th, "speed");
    const hr = calibrationDisplay(th, "hr");
    expect(speed.status).toBe("先验主导 · 基于研究先验估计");
    // v4 rev3: HRmax needs a real observed source; with none the HR channel
    // is unavailable with its categorical reason (§6.4 row 4).
    expect(hr.status).toBe("暂无估计 · 没有心率序列，也没有可用的静息心率先验");
    expect(speed.details.join(" ")).toContain("仅短时、低质量或单层证据，先验主导");
    expect(speed.value).not.toBe("—");
    expect(hr.value).toBe("—");
  });

  it("keeps the verified reference informative without echoing it as a measured center", () => {
    const th = caseThreshold("evolved-measured-reference");
    // v4 rev3 §8.3 publishes four output states: the verified reference
    // informs the constrained fit (model_estimated), it is never echoed as
    // a measured_reference center.
    expect(calibrationDisplay(th, "speed").status).toBe("模型估计 · 基于你的普通训练估计");
    expect(calibrationDisplay(th, "hr").status).toBe("先验主导 · 基于研究先验估计");
    const hr = calibrationDisplay(th, "hr");
    expect(hr.details.join(" ")).toContain("对数速度回归");
    expect(hr.details.join(" ")).toContain("模型推算稳态心率");
  });

  it("explains unavailable estimates with categorical reasons and no invented values", () => {
    const th = caseThreshold("evolved-unavailable");
    const speed = calibrationDisplay(th, "speed");
    const hr = calibrationDisplay(th, "hr");
    expect(speed.status).toBe("暂无估计 · 窗口内没有有效跑步输入");
    expect(hr.status).toBe("暂无估计 · 没有心率序列，也没有可用的静息心率先验");
    expect(speed.value).toBe("—");
    expect(hr.value).toBe("—");
    expect(speed.range).toBeNull();
    expect(hr.range).toBeNull();
  });

  it("reads historical v4 rows without borrowing five-state or revision labels", () => {
    const th = caseThreshold("historical-v4");
    const speed = calibrationDisplay(th, "speed");
    expect(speed.status).toBe("估计支持 高");
    expect(speed.details).toContain("当前有效算法 v4");
    expect(speed.details.join(" ")).not.toContain("修订");
    expect(speed.details.join(" ")).not.toContain("模型估计");
  });

  it("discloses the per-user override pin and its snapshot-missing fallback separately", () => {
    const pinned = caseThreshold("override-selected");
    expect(pinned.selection?.override?.algorithm_revision).toBe("v4-rev3-2026-11");
    expect(calibrationDisplay(pinned, "speed").details).toContain("已按你的选择使用 v4（修订 v4-rev3-2026-11）");
    expect(calibrationDisplay(pinned, "speed").details).toContain("当前有效算法 v4 · 修订 v4-rev3-2026-11");
    const fallback = caseThreshold("override-fallback");
    const speed = calibrationDisplay(fallback, "speed");
    expect(speed.details).toContain("你选择的版本在该日期无快照，暂用全局有效版本");
    expect(speed.details).toContain("当前有效算法 v3");
    expect(speed.details.join(" ")).not.toContain("已按你的选择使用");
  });

  it("degrades unknown future states conservatively without losing the value", () => {
    const th = structuredClone(fixture.cases[0].response.threshold) as StrideThreshold;
    if (!th.source?.speed) throw new Error("missing speed source");
    th.source.speed.state = "some_future_state";
    const display = calibrationDisplay(th, "speed");
    expect(display.value).toBe("3:34");
    expect(display.status).toBe("来源信息暂不可用");
  });

});
