import assert from "node:assert/strict";
import { test } from "node:test";
import { makeIntent, phase } from "../testSupport.js";
import type { LoadWeek } from "./expand.js";
import { validateLoad } from "./gates.js";

/** 六条验收门逐条正反（devops#793 E 节，含两个 spike 实测陷阱的反例）。 */

const seed = [60, 60, 60, 60];

type Row = [number, string, number, "progress" | "absorb" | "taper" | "race", number, number | null, number];

/** 手搓周骨架（canonical 全同相位默认 foundation，单独传 phase 行映射）。 */
function weeks(rows: Row[]): LoadWeek[] {
  return rows.map(([week, canonical, block, role, km, lr, q]) => ({ week, canonical: canonical as never, block, role, km, lr, q }));
}

const failOf = (checks: ReturnType<typeof validateLoad>, id: string) => checks.find((c) => c.id.startsWith(id));

test("H1/H2：ACWR 超限与单周尖峰逐周可判", () => {
  const ok = validateLoad(
    makeIntent({}),
    weeks([
      [1, "foundation", 1, "progress", 60, 21.6, 1],
      [2, "foundation", 1, "progress", 75, 27, 1],
      [3, "foundation", 1, "progress", 80, 28.8, 2],
    ]),
    seed,
  );
  assert.ok(failOf(ok, "H1")!.pass);
  const spike = validateLoad(
    makeIntent({}),
    weeks([
      [1, "foundation", 1, "progress", 60, 21.6, 1],
      [2, "foundation", 1, "progress", 100, 36, 2],
    ]),
    seed,
  );
  assert.ok(!failOf(spike, "H1")!.pass); // 100 > 1.3×60+0.5
  const bigSpike = validateLoad(
    makeIntent({}),
    weeks([
      [1, "foundation", 1, "progress", 60, 21.6, 1],
      [2, "foundation", 1, "progress", 130, 36, 2],
    ]),
    seed,
  );
  assert.ok(!failOf(bigSpike, "H2")!.pass); // 130 > 1.5×60+0.5（H1 也挂，H2 证明尖峰门独立可判）
});

test("H3：块对块 +25% 可判；豁免「跨阶段进更高带」须用真实阶段行匹配中文引用（陷阱反例）", () => {
  // 真实形态：F 块 40 → transQ 块 55（+37%）但 transQ 带 lo=55 为「进更高带」。
  // 陷阱：volume_bands 引用是中文显示名，阶段行必须带真名——拿 canonical 造
  // 假行（name=canonical）永远匹配不上（spike 实测陷阱）
  const intent = makeIntent({
    phases: [
      phase("foundation", 1, 3, { name: "第一阶段·基础期（W1-W3）" }),
      phase("transition_quality", 4, 6, { name: "第三阶段·过渡质量期（W4-W6）" }),
      phase("final_quality", 7, 8, { name: "第四阶段·最终质量期（W7-W8）" }),
    ],
    taperWeeks: 1,
    volumeBands: [
      { phase: "第一阶段·基础期（W1-W3）", weekly_km_min: 35, weekly_km_max: 45 },
      { phase: "第三阶段·过渡质量期（W4-W6）", weekly_km_min: 55, weekly_km_max: 70 },
      { phase: "第四阶段·最终质量期（W7-W8）", weekly_km_min: 55, weekly_km_max: 70 },
    ],
  });
  const ramp = weeks([
    [1, "foundation", 1, "progress", 38, 13.7, 1],
    [2, "foundation", 1, "progress", 40, 14.4, 1],
    [3, "foundation", 1, "progress", 41, 14.8, 1],
    [4, "transition_quality", 2, "progress", 56, 20.2, 1],
    [5, "transition_quality", 2, "progress", 57, 20.5, 1],
    [6, "transition_quality", 2, "progress", 58, 20.9, 1],
    [7, "final_quality", 3, "progress", 58, 20.9, 1],
    [8, "final_quality", 3, "race", 32, null, 1],
  ]);
  const checks = validateLoad(intent, ramp, [38, 38, 38, 38]);
  assert.ok(failOf(checks, "H3")!.pass, failOf(checks, "H3")!.detail); // 跨阶段进更高带豁免生效

  // 反例：同相位内两块跳 +25%（40→58）无豁免可言（跨相位进更高带才有豁免）
  const jump = weeks([
    [1, "foundation", 1, "progress", 38, 13.7, 1],
    [2, "foundation", 1, "progress", 40, 14.4, 1],
    [3, "foundation", 1, "progress", 41, 14.8, 1],
    [4, "foundation", 2, "progress", 56, 20.2, 1],
    [5, "foundation", 2, "progress", 58, 20.9, 1],
    [6, "foundation", 2, "progress", 60, 21.6, 1],
    [7, "final_quality", 3, "progress", 60, 21.6, 1],
    [8, "final_quality", 3, "race", 33, null, 1],
  ]);
  assert.ok(!failOf(validateLoad(intent, jump, [38, 38, 38, 38]), "H3")!.pass);
});

test("L1 带贴合：低于 lo 且非爬坡、非帽压制挂；两种合法爬坡形态过", () => {
  const intent = makeIntent({
    phases: [phase("foundation", 1, 4), phase("final_quality", 5, 6)],
    taperWeeks: 1,
    volumeBands: [
      { phase: "foundation", weekly_km_min: 65, weekly_km_max: 85 },
      { phase: "final_quality", weekly_km_min: 65, weekly_km_max: 85 },
    ],
  });
  // 负例：低位递减（58→52），高于 ACWR 帽（种子 40）且不在爬坡
  const dipping = weeks([
    [1, "foundation", 1, "progress", 58, 20.9, 1],
    [2, "foundation", 1, "progress", 56, 20.2, 1],
    [3, "foundation", 1, "progress", 54, 19.4, 1],
    [4, "foundation", 1, "progress", 52, 18.7, 1],
    [5, "final_quality", 2, "progress", 70, 25.2, 1],
    [6, "final_quality", 2, "race", 38, null, 1],
  ]);
  assert.ok(!failOf(validateLoad(intent, dipping, [40, 40, 40, 40]), "L1")!.pass);

  // 合法形态 A：低于 lo 但逐周递进（爬坡豁免；首周吃帽压制豁免）
  const ramping = weeks([
    [1, "foundation", 1, "progress", 50, 18, 1],
    [2, "foundation", 1, "progress", 55, 19.8, 1],
    [3, "foundation", 1, "progress", 60, 21.6, 1],
    [4, "foundation", 1, "progress", 65, 23.4, 1],
    [5, "final_quality", 2, "progress", 70, 25.2, 1],
    [6, "final_quality", 2, "race", 38, null, 1],
  ]);
  assert.ok(failOf(validateLoad(intent, ramping, [50, 50, 50, 50]), "L1")!.pass);

  // 合法形态 B：被 ACWR 帽压制的缓坡（52-62km 恒低于 1.3×滚动均值）
  const suppressed = weeks([
    [1, "foundation", 1, "progress", 55, 19.8, 1],
    [2, "foundation", 1, "progress", 58, 20.9, 1],
    [3, "foundation", 1, "progress", 60, 21.6, 1],
    [4, "foundation", 1, "progress", 61, 21.9, 1],
    [5, "final_quality", 2, "progress", 62, 22.3, 1],
    [6, "final_quality", 2, "race", 34, null, 1],
  ]);
  assert.ok(failOf(validateLoad(intent, suppressed, [45, 45, 45, 45]), "L1")!.pass);
});

test("L2 节奏：建设周 ≥8 缺吸收周挂；短跑道豁免", () => {
  const mk = (n: number, withAbsorb: boolean) =>
    weeks(
      Array.from({ length: n }, (_, i) => {
        const w = i + 1;
        const role = withAbsorb && (i + 1) % 4 === 0 ? "absorb" : w === n ? "race" : w === n - 1 ? "taper" : "progress";
        return [w, "foundation", Math.floor(i / 3) + 1, role, role === "absorb" ? 45 : role === "taper" ? 55 : 60, 21.6, 1] as Row;
      }),
    );
  const longIntent = makeIntent({
    phases: [phase("foundation", 1, 10), phase("final_quality", 11, 12)],
    taperWeeks: 1,
    volumeBands: [
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "final_quality", weekly_km_min: 40, weekly_km_max: 70 },
    ],
  });
  assert.ok(!failOf(validateLoad(longIntent, mk(12, false), seed), "L2")!.pass); // 10 建设周 0 吸收
  assert.ok(failOf(validateLoad(longIntent, mk(12, true), seed), "L2")!.pass);
  const shortIntent = makeIntent({
    phases: [phase("foundation", 1, 4), phase("final_quality", 5, 6)],
    taperWeeks: 1,
    volumeBands: [
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "final_quality", weekly_km_min: 40, weekly_km_max: 70 },
    ],
  });
  assert.ok(failOf(validateLoad(shortIntent, mk(6, false), seed), "L2")!.pass); // 4 建设周：豁免
});

test("L3 LR：峰值低于下限挂；赛周 LR 非 null 挂；相位末 LR 倒挂挂", () => {
  const intent = makeIntent({
    phases: [phase("foundation", 1, 5), phase("final_quality", 6, 7)],
    taperWeeks: 1,
    volumeBands: [
      { phase: "foundation", weekly_km_min: 50, weekly_km_max: 75 },
      { phase: "final_quality", weekly_km_min: 50, weekly_km_max: 75 },
    ],
  });
  const ok = weeks([
    [1, "foundation", 1, "progress", 60, 22, 1],
    [2, "foundation", 1, "progress", 64, 23, 1],
    [3, "foundation", 1, "progress", 68, 24.5, 2],
    [4, "foundation", 2, "progress", 70, 25.2, 2],
    [5, "foundation", 2, "progress", 72, 25.9, 2],
    [6, "final_quality", 3, "taper", 55, 19.8, 1],
    [7, "final_quality", 3, "race", 32, null, 1],
  ]);
  assert.ok(failOf(validateLoad(intent, ok, seed), "L3")!.pass);

  const lowLr = ok.map((w) => (w.lr != null ? { ...w, lr: Math.min(w.lr, 15) } : w));
  assert.ok(!failOf(validateLoad(intent, lowLr, seed), "L3")!.pass); // LR 峰 15 < 下限 22

  const raceLr = ok.map((w) => (w.role === "race" ? { ...w, lr: 10 } : w));
  assert.ok(!failOf(validateLoad(intent, raceLr, seed), "L3")!.pass); // 赛周 LR 非 null

  const inverted = ok.map((w) => (w.week === 5 ? { ...w, lr: 18 } : w)); // 相位末 18 vs 相位内峰 25.2 → 倒挂
  assert.ok(!failOf(validateLoad(intent, inverted, seed), "L3")!.pass);
});

test("L4 taper：递增段挂（单调公式方向反例——写反会把递减判成递增）；削减深度出界挂", () => {
  const intent = makeIntent({
    phases: [phase("foundation", 1, 5), phase("final_quality", 6, 8)],
    taperWeeks: 2,
    volumeBands: [
      { phase: "foundation", weekly_km_min: 50, weekly_km_max: 75 },
      { phase: "final_quality", weekly_km_min: 50, weekly_km_max: 75 },
    ],
  });
  const good = weeks([
    [1, "foundation", 1, "progress", 60, 22, 1],
    [2, "foundation", 1, "progress", 64, 23, 1],
    [3, "foundation", 1, "progress", 68, 24.5, 2],
    [4, "foundation", 2, "progress", 70, 25.2, 2],
    [5, "foundation", 2, "progress", 70, 25.2, 2],
    [6, "final_quality", 3, "progress", 70, 25.2, 2],
    [7, "final_quality", 3, "taper", 60, 21.6, 1],
    [8, "final_quality", 3, "race", 38, null, 1], // 0.55×70 削减 45%
  ]);
  const checks = validateLoad(intent, good, seed);
  assert.ok(failOf(checks, "L4")!.pass, failOf(checks, "L4")!.detail);

  const rising = weeks([
    [1, "foundation", 1, "progress", 60, 22, 1],
    [2, "foundation", 1, "progress", 64, 23, 1],
    [3, "foundation", 1, "progress", 68, 24.5, 2],
    [4, "foundation", 2, "progress", 70, 25.2, 2],
    [5, "foundation", 2, "progress", 70, 25.2, 2],
    [6, "final_quality", 3, "progress", 70, 25.2, 2],
    [7, "final_quality", 3, "taper", 55, 19.8, 1],
    [8, "final_quality", 3, "race", 66, null, 1], // taper 段 55 → 赛周 66 递增
  ]);
  assert.ok(!failOf(validateLoad(intent, rising, seed), "L4")!.pass);

  const tooDeep = good.map((w) => (w.role === "race" ? { ...w, km: 25 } : w)); // 削减 64% > 50%
  assert.ok(!failOf(validateLoad(intent, tooDeep, seed), "L4")!.pass);
});

test("L5 块内微阶梯：全平台直排挂；无 ≥3 周块豁免", () => {
  const intent = makeIntent({
    phases: [phase("foundation", 1, 5), phase("final_quality", 6, 7)],
    taperWeeks: 1,
    volumeBands: [
      { phase: "foundation", weekly_km_min: 50, weekly_km_max: 75 },
      { phase: "final_quality", weekly_km_min: 50, weekly_km_max: 75 },
    ],
  });
  const flat = weeks([
    [1, "foundation", 1, "progress", 60, 21.6, 1],
    [2, "foundation", 1, "progress", 60, 21.6, 1],
    [3, "foundation", 1, "progress", 60, 21.6, 1],
    [4, "foundation", 1, "progress", 60, 21.6, 1],
    [5, "foundation", 1, "progress", 60, 21.6, 1],
    [6, "final_quality", 2, "progress", 60, 21.6, 1],
    [7, "final_quality", 2, "race", 33, null, 1],
  ]);
  assert.ok(!failOf(validateLoad(intent, flat, seed), "L5")!.pass); // 5 个同块建设周全等

  const shortIntent = makeIntent({
    phases: [phase("final_quality", 1, 3)],
    taperWeeks: 1,
    volumeBands: [{ phase: "final_quality", weekly_km_min: 40, weekly_km_max: 60 }],
  });
  const short = weeks([
    [1, "final_quality", 1, "progress", 50, 18, 1],
    [2, "final_quality", 1, "taper", 42, 15.1, 1],
    [3, "final_quality", 1, "race", 25, null, 1],
  ]);
  assert.ok(failOf(validateLoad(shortIntent, short, seed), "L5")!.pass); // 无 ≥3 建设周块：豁免
});

test("L2 节奏：rec2 前置不计入建设周（评审回归——与展开器吸收计数同口径）", () => {
  // rec2 + 7 个建设周 + 1 吸收 + taper + race：建设周=7（<8 豁免）；
  // 旧口径把 recovery 计入（9）会要求 ≥2 吸收而误挂
  const intent = makeIntent({
    phases: [phase("recovery", 1, 2), phase("foundation", 3, 10), phase("final_quality", 11, 12)],
    taperWeeks: 1,
    volumeBands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 40 },
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "final_quality", weekly_km_min: 40, weekly_km_max: 70 },
    ],
  });
  const rows: Row[] = [
    [1, "recovery", 1, "progress", 25, 7.5, 0],
    [2, "recovery", 1, "progress", 25, 7.5, 0],
    [3, "foundation", 2, "progress", 45, 16.2, 0],
    [4, "foundation", 2, "progress", 50, 18, 1],
    [5, "foundation", 2, "progress", 55, 19.8, 1],
    [6, "foundation", 3, "absorb", 40, 14.4, 0],
    [7, "foundation", 3, "progress", 55, 19.8, 1],
    [8, "foundation", 3, "progress", 58, 20.9, 1],
    [9, "foundation", 3, "progress", 60, 21.6, 1],
    [10, "foundation", 3, "progress", 60, 21.6, 1],
    [11, "final_quality", 4, "taper", 50, 18, 1],
    [12, "final_quality", 4, "race", 28, null, 1],
  ];
  assert.ok(failOf(validateLoad(intent, weeks(rows), [50, 50, 50, 50]), "L2")!.pass);
});
