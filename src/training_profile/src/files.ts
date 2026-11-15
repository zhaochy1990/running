import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shanghaiIso } from "@stride/contract";
import type { Profile } from "./types.js";

export const layerLabels = { historical: "历史事实、经历与当次陈述", long_term: "相对稳定的长期认识", rolling: "滚动观察与估计", unknown: "生命周期尚不明确" };
const kindLabels = { fact: "记录／统计事实", estimate: "已有算法估计", user_report: "本人原文陈述", candidate: "系统综合观察／候选", insight: "个体认识" };

/** Rearranges the same immutable conclusions; layering never changes their meaning. */
export function layeredView(profile: Profile) {
  return Object.entries(layerLabels).map(([lifecycle, title]) => {
    const selected = profile.conclusions.filter((c) => c.lifecycle === lifecycle);
    return {
      lifecycle,
      title,
      dimensions: [...new Set(selected.map((c) => c.dimension))].map((dimension) => ({
        dimension,
        items: selected.filter((c) => c.dimension === dimension),
      })),
    };
  });
}

export function renderMarkdown(profile: Profile): string {
  const lines = [
    "# 运动能力与训练特点 · POC",
    `资料窗口：${profile.window.startDay} 至 ${profile.window.endDay}；生成：${shanghaiIso(profile.evaluatedAt)}。`,
    "每项认识给出依据和计划用途。原始统计、比较方法及待核验方向保存在 analysis.json。",
  ];
  for (const layer of layeredView(profile)) {
    if (!layer.dimensions.length) continue;
    lines.push(`## ${layer.title}`);
    for (const { dimension, items } of layer.dimensions) {
      lines.push(`### ${dimension}`);
      for (const c of items)
        lines.push(
          `**${c.title} · ${kindLabels[c.kind]}**`,
          c.text,
          ...(c.planningUse ? [`计划用途：${c.planningUse}`] : []),
          ...(c.support
            ? [
                `证据描述：${{ repeated_observation: "多次观察支持", preliminary_association: "初步关联，供柔性提示", single_episode: "单次事件，供交叉解读" }[c.support]}。`,
              ]
            : []),
          `来源日期：${c.sourceDates[0] ?? "未知"}${c.sourceDates.length > 1 ? ` 至 ${c.sourceDates.at(-1)}` : ""}。`,
          `条目ID：${c.id}；来源 ${c.evidence.length} 条（完整标识与内容修订摘要见JSON）。`,
        );
    }
  }
  lines.push(
    ...(profile.conclusions.length ? [] : ["本次未形成可供计划引用的个体认识，未达到内容验收目标。"]),
    "## 变化依据",
    profile.change.reason,
    `不再有效的旧结论：${profile.change.removedConclusionIds.join("、") || "无／首次生成"}。`,
  );
  return `${lines.join("\n\n")}\n`;
}

/** Dedicated private run directory, refuses overwrites of an earlier run. */
export async function createRunDirectory(path: string) {
  await mkdir(path, { mode: 0o700 });
}
export async function savePrivate(path: string, name: string, value: unknown) {
  await writeFile(join(path, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
export async function saveProfile(path: string, profile: Profile) {
  await savePrivate(path, "profile.json", profile);
  await savePrivate(path, "layered.json", layeredView(profile));
  await writeFile(join(path, "profile.md"), renderMarkdown(profile), { mode: 0o600, flag: "wx" });
}
