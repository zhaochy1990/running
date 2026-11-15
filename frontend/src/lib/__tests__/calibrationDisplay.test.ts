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
    if (c.name === "low-stale") expect(hr.details).toContain("证据陈旧，需更新有效证据");
    if (c.name === "constraints-only") expect(speed.details).toContain("无法可靠估计中心值");
    if (c.name === "legacy") expect(hr.details.join(" ")).toContain("不能视为独立检测值");
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

});
