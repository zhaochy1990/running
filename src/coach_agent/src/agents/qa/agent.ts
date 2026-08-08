import { buildResponsesModel } from "../common.js";
import { createActivitiesTools } from "../../tools/activities.js";
import { createTrainingLoadTools } from "../../tools/trainingLoad.js";
import { createLoggingMiddleware } from "../middleware.js";
import type { StrideDataStore } from "../../persistence/index.js";
import type { ModelConfig } from "../../config/config.js";

// TODO: 关于跑步知识需要外接知识库
export function getQaSubagent(store: StrideDataStore, config: ModelConfig) {
    const activitiesTools = createActivitiesTools(store);
    const trainingLoadTools = createTrainingLoadTools(store);

    const QA_SUBAGENT_PROMPT = `你是 STRIDE 跑步教练的训练问答专家，你可以回答用户关于训练的问题。包括下面几类：
1. 今天/最近跑得怎么样？（今天的跑步数据、最近的训练状态）
2. 训练状态、疲劳与负荷（训练负荷、疲劳状态、恢复情况）
3. 跑步知识（跑步技巧、训练方法、运动科学知识）

工具与数据：
- get_activities_by_date_range：拿某段时间的每次跑步明细，其中 strideDose 是这次训练的 STRIDE 负荷值（TSS-scaled，1h 阈值≈100）。
- get_daily_training_load：拿每天的负荷（长期负荷 chronicLoad、短期负荷 acuteLoad、负荷比 loadRatio、form=chronic−acute、就绪度 readinessGate）。

只要问题涉及疲劳、负荷、恢复、状态、能否加量，都必须先调用 get_daily_training_load 拿到近期负荷趋势，并结合 chronic/acute/loadRatio/form 分析后再作答；不要只凭单次跑步的感觉下结论。

你不对运动员的训练计划进行修改或调整，也不提供个性化训练建议。你只回答运动员关于训练的问题，并且只依据工具数据说话。
    `;

    return {
        name: "training_question",
        description: "回答关于运动员自己训练的问题：今天/最近跑得怎么样、训练状态、疲劳与负荷、跑步知识。",
        systemPrompt: QA_SUBAGENT_PROMPT,
        tools: [...activitiesTools, ...trainingLoadTools],
        model: buildResponsesModel(config),
        middleware: [createLoggingMiddleware("agent:qa")],
        // Skill loaded via SkillsMiddleware from the deep agent's FilesystemBackend
        // (rooted at `dist/agents/skills/` in coachAgent.ts). The agent reads the
        // full SKILL.md on demand via read_file. Path is relative to that root.
        skills: ["/analyze-activity/"],
    };
}
