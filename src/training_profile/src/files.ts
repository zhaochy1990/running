import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shanghaiIso } from "@stride/contract";
import { DimensionId, dimensions, formationLabels, natureLabels } from "./dimensions.js";
import type { Profile } from "./types.js";

export const layerLabels = { historical: "历史事实、经历与当次陈述", long_term: "相对稳定的长期认识", rolling: "滚动观察与估计", unknown: "生命周期尚不明确" };
const kindLabels = { fact: "记录／统计事实", estimate: "已有算法估计", user_report: "本人原文陈述", candidate: "系统综合观察／候选", insight: "系统综合推断" };

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
  if (profile.method.startsWith("ten-dimension-")) return renderDimensions(profile);
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
          `条目ID：${c.id}；输入依赖范围 ${c.evidence.length} 条（不是支持样本数；实际正反样本与计算见analysis.json，来源标识见JSON）。`,
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

export function dimensionView(profile: Profile) {
  return DimensionId.options.map((id) => ({
    dimensionId: id,
    title: dimensions[id],
    items: profile.conclusions.filter((c) => c.metadata?.dimensionId === id),
  }));
}
function renderDimensions(profile: Profile) {
  const lines = [
    "# 训练画像 · 十维 POC",
    `资料窗口：${profile.window.startDay} 至 ${profile.window.endDay}；生成：${shanghaiIso(profile.evaluatedAt)}。`,
    "本文件为代码与Flash多Agent的原始汇总，内容质量另行审阅。空维度与失败记录见coverage.md；计算、反例与取舍见analysis.json。",
  ];
  if (profile.highlights?.length)
    lines.push(
      "## 本轮重点",
      ...profile.highlights.map((id) => {
        const c = profile.conclusions.find((c) => c.id === id);
        return `- ${c?.title ?? id}（${id}）`;
      }),
    );
  for (const dimension of dimensionView(profile)) {
    if (!dimension.items.length) continue;
    lines.push(`## ${dimension.title}`);
    for (const c of dimension.items) {
      const m = c.metadata;
      if (!m) continue;
      lines.push(
        `### ${c.title}`,
        `性质：${natureLabels[m.nature]}｜来源：${m.sourceTypes.join("、")}｜形成：${formationLabels[m.formation]}｜计算：${m.computation}｜生命周期：${layerLabels[c.lifecycle]}。`,
        c.text,
        ...(c.planningUse ? [`计划可引用：${c.planningUse}`] : []),
        `适用范围：${c.conditions}`,
        ...(c.support ? [`支持描述：${c.support}；沿用原证据程度。`] : []),
        ...(c.limitations.length ? [`使用边界：${c.limitations.join("；")}`] : []),
        `条目：${c.id}；形成者：${m.producer}${m.reviewStatus ? `；历史处理：${m.reviewStatus}` : ""}。实际选用来源 ${m.supportingSources.length} 条；输入依赖 ${c.evidence.length} 条，均不是独立样本数。方法与完整引用见JSON。`,
      );
    }
  }
  if (profile.previousDecisions?.length)
    lines.push(
      "## 旧认识处置",
      [
        "|原条目|处置|后续条目|依据|",
        "|---|---|---|---|",
        ...profile.previousDecisions.map((d) => `|${d.id}|${d.action}|${d.replacementId ?? "原条目／无替代"}|${d.reason.replaceAll("|", "／")}|`),
      ].join("\n"),
    );
  lines.push("## 变化说明", profile.change.reason);
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
  await savePrivate(path, "dimensions.json", dimensionView(profile));
  await writeFile(join(path, "profile.md"), renderMarkdown(profile), { mode: 0o600, flag: "wx" });
}
