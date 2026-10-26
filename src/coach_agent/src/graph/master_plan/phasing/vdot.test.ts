import assert from "node:assert/strict";
import { test } from "node:test";
import { equivalentsFromVdot, RACE_DISTANCES_M, type RaceDistanceKey, raceTimeSecFromVdot, vdotFromRace, vdotFromThresholdPace } from "./vdot.js";

const parseHms = (s: string) => {
  const parts = s.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
};

/**
 * 原书表锚点（误差 ≤±1% 验收）：组 1 取自 #789 票面 2nd 版书行（5K/10K/HM
 * 列与公开方程一致）；组 2-4 取自公开方程一致表（janboll/kalamazoo/ZacBlanco
 * 三源互证）。FM 列说明：2nd 版书 @VDOT50 印 3:19:03（人工保守修订，公开
 * 方程/官方 V.O2 计算器均给 3:10:4x；3:19:03 在公开方程下=VDOT47.5）——
 * FM 锚点按公开方程值断言，2nd 版偏差见下方专测。
 */
const ANCHORS: Array<{ vdot: number; times: Partial<Record<RaceDistanceKey, string>> }> = [
  { vdot: 50, times: { "5K": "19:57", "10K": "41:31", HM: "1:31:17" } },
  { vdot: 40, times: { "5K": "24:06", "10K": "50:01", HM: "1:50:54" } },
  { vdot: 60, times: { "5K": "17:03", "10K": "35:22", HM: "1:18:09", FM: "2:43:22" } },
  { vdot: 70, times: { "5K": "14:56", "10K": "31:01", HM: "1:08:23", FM: "2:23:13" } },
];

test("VDOT 锚点：比赛成绩→VDOT 对照原书表，误差 ≤±1%", () => {
  for (const { vdot, times } of ANCHORS) {
    for (const [key, time] of Object.entries(times) as Array<[RaceDistanceKey, string]>) {
      const got = vdotFromRace(RACE_DISTANCES_M[key], parseHms(time));
      const err = Math.abs(got - vdot) / vdot;
      assert.ok(err <= 0.01, `${key} ${time} → VDOT ${got.toFixed(2)}，期望 ${vdot}，误差 ${(err * 100).toFixed(2)}%`);
    }
  }
});

test("VDOT 锚点：VDOT→等效时间对照原书表，误差 ≤±1%（双向换算）", () => {
  for (const { vdot, times } of ANCHORS) {
    for (const [key, time] of Object.entries(times) as Array<[RaceDistanceKey, string]>) {
      const anchorSec = parseHms(time);
      const got = raceTimeSecFromVdot(RACE_DISTANCES_M[key], vdot);
      const err = Math.abs(got - anchorSec) / anchorSec;
      assert.ok(
        err <= 0.01,
        `VDOT ${vdot} → ${key} ${Math.floor(got / 60)}:${String(got % 60).padStart(2, "0")}，期望 ${time}，误差 ${(err * 100).toFixed(2)}%`,
      );
    }
  }
});

test("FM 列 2nd 版偏差记录：VDOT50 官方方程 ≈3:10:4x；2nd 版书 3:19:03 = 公开方程 VDOT≈47.5", () => {
  const official = raceTimeSecFromVdot(RACE_DISTANCES_M.FM, 50);
  assert.ok(Math.abs(official - parseHms("3:10:40")) / parseHms("3:10:40") <= 0.01);
  const secondEdMarathon = vdotFromRace(RACE_DISTANCES_M.FM, parseHms("3:19:03"));
  assert.ok(Math.abs(secondEdMarathon - 47.5) / 47.5 <= 0.02, `2nd 版 FM@50 行按公开方程 = ${secondEdMarathon.toFixed(1)}`);
});

test("校准阈值配速→VDOT：4:02/km（#789 设计校准例）≈ 52.9", () => {
  const vdot = vdotFromThresholdPace(242);
  assert.ok(Math.abs(vdot - 52.9) <= 0.15, `4:02/km → VDOT ${vdot.toFixed(2)}`);
});

test("equivalentsFromVdot：四键齐全、单调（距离越长秒数越大）、往返自洽", () => {
  const eq = equivalentsFromVdot(50);
  assert.deepEqual(Object.keys(eq), ["5K", "10K", "HM", "FM"]);
  assert.ok(eq["5K"] < eq["10K"] && eq["10K"] < eq.HM && eq.HM < eq.FM);
  const back = vdotFromRace(RACE_DISTANCES_M.FM, eq.FM);
  assert.ok(Math.abs(back - 50) / 50 <= 0.005, `FM 往返 ${back.toFixed(2)}`);
});

test("equivalentsFromVdot：短距离源折扣只打在更长距离上", () => {
  const plain = equivalentsFromVdot(55);
  const from10K = equivalentsFromVdot(55, { sourceKey: "10K", discountLonger: 1.03 });
  assert.equal(from10K["5K"], plain["5K"]);
  assert.equal(from10K["10K"], plain["10K"]);
  assert.ok(Math.abs(from10K.HM - plain.HM * 1.03) <= 1);
  assert.ok(Math.abs(from10K.FM - plain.FM * 1.03) <= 1);
});

test("无效入参返回 NaN（距离 <1200m / 非正时间 / 非法值）", () => {
  assert.ok(Number.isNaN(vdotFromRace(1000, 240)));
  assert.ok(Number.isNaN(vdotFromRace(5000, 0)));
  assert.ok(Number.isNaN(vdotFromRace(Number.NaN, 1000)));
  assert.ok(Number.isNaN(raceTimeSecFromVdot(5000, 0)));
  assert.ok(Number.isNaN(vdotFromThresholdPace(0)));
});
