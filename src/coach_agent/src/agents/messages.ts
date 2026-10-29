import type { BaseMessage } from "@langchain/core/messages";

/**
 * devops#833：responses API 模型的回复 AIMessage content 是 content-parts 数组
 * （[{type:"text",text}, …]，实测含空数组），原样写入会话历史后被 chat-completions
 * 侧（意图分类器）经 langchain 原样回传，DeepSeek 对数组形态的 assistant 历史发生
 * 格式模仿、json_object 约束被破坏（实测返回纯空白文本）→ 分类 decode 必挂
 * fallback、用户换不了意图。写入侧（业务节点写回前）与读取侧（orchestrator 构造
 * 分类输入时）都须归一化为纯字符串。
 *
 * 规则与 BaseMessage.text getter 一致：拼接 type==="text" 块，非 text 块丢弃，
 * 空数组→空串；字符串 content 原样透传（同一引用，干净消息零拷贝）。
 * additional_kwargs（card 等结构化产物）、tool_calls、id 等字段经构造器原样
 * 保留，只动 content。
 */
export function normalizeMessageContent(message: BaseMessage): BaseMessage {
  if (typeof message.content === "string") return message;
  // Serializable 内部属性（lc_kwargs/lc_namespace 等，均为 own enumerable）与
  // type/contentBlocks 不能进构造字段：lc_kwargs 会随新消息自己的 lc_kwargs
  // 嵌套进 checkpoint blob 且逐轮序列化循环每层加深一档（评审实证：三轮
  // dumpsTyped→load 719→944→1169 字节）；contentBlocks 是 v1 元数据形态的
  // content 伴生物，归一化为字符串后一并剥离。
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    if (key !== "type" && key !== "contentBlocks" && !key.startsWith("lc_")) fields[key] = value;
  }
  const Ctor = message.constructor as new (fields: Record<string, unknown>) => BaseMessage;
  const rebuilt = new Ctor({ ...fields, content: message.text });
  // 防御构造器把 content 又变回数组（如 response_metadata.output_version ===
  // "v1" 时 langchain 会把 content 转回 contentBlocks）：字符串不变式不成立就
  // 去掉 response_metadata 重建一次。
  if (typeof rebuilt.content === "string") return rebuilt;
  return new Ctor({ ...fields, response_metadata: {}, content: message.text });
}
