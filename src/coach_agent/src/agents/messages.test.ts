import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { normalizeMessageContent } from "./messages.js";

/**
 * devops#833：responses API 的 AIMessage content 是 content-parts 数组（含空
 * 数组），污染会话历史后击穿 chat-completions 分类器。归一化规则与
 * BaseMessage.text getter 一致；additional_kwargs（card）与 tool_calls 等
 * 字段必须原样保留。
 */
test("normalizeMessageContent joins text blocks in order and drops non-text blocks", () => {
  const message = new AIMessage({
    content: [{ type: "text", text: "分段配速已生成。" }, { type: "text", text: "补给方案见卡片。" }, { type: "usage" }],
  });
  const normalized = normalizeMessageContent(message);
  assert.equal(normalized.content, "分段配速已生成。补给方案见卡片。");
});

test("normalizeMessageContent maps an empty content array to the empty string", () => {
  // 10-29 生产取证：深会话里实测存在 content=[] 的 assistant 消息，正是它把
  // JSON.parse 喂成 "Unexpected end of JSON input"。
  const message = new AIMessage({ content: [] });
  assert.equal(normalizeMessageContent(message).content, "");
});

test("normalizeMessageContent passes string content through untouched", () => {
  const message = new AIMessage("纯文本回复");
  assert.strictEqual(normalizeMessageContent(message), message);
});

test("normalizeMessageContent preserves message type, id, name, card envelope and tool calls", () => {
  const toolCall = { name: "ToolStrategy", args: { disposition: "return_direct" }, id: "call_1", type: "tool_call" } as const;
  const card = { $type: "race-strategy", data: { race_name: "杭州马拉松" } };
  const message = new AIMessage({
    content: [{ type: "text", text: "策略已生成。" }],
    id: "msg-1",
    name: "model",
    additional_kwargs: { card },
    tool_calls: [toolCall],
  });
  const normalized = normalizeMessageContent(message);
  assert.ok(normalized instanceof AIMessage);
  assert.equal(normalized.content, "策略已生成。");
  assert.equal(normalized.id, "msg-1");
  assert.equal(normalized.name, "model");
  assert.deepEqual(normalized.additional_kwargs.card, card);
  assert.deepEqual(normalized.tool_calls, [toolCall]);
});

test("normalizeMessageContent keeps ToolMessage's tool_call_id", () => {
  const tool = normalizeMessageContent(new ToolMessage({ content: [{ type: "text", text: "工具结果" }], tool_call_id: "call_1" }));
  assert.ok(tool instanceof ToolMessage);
  assert.equal(tool.content, "工具结果");
  assert.equal(tool.tool_call_id, "call_1");
});

test("normalizeMessageContent defeats the v1 metadata path that re-coerces content to blocks", () => {
  // response_metadata.output_version === "v1" 时 AIMessage 构造器会把字符串
  // content 转回 contentBlocks 数组（content 置 undefined）；不变式必须守住。
  const message = new AIMessage({
    content: [{ type: "text", text: "策略已生成。" }],
    response_metadata: { output_version: "v1" },
    additional_kwargs: { note: "keep" },
  });
  assert.ok(Array.isArray(message.content));
  const normalized = normalizeMessageContent(message);
  assert.equal(normalized.content, "策略已生成。");
  assert.deepEqual(normalized.additional_kwargs, { note: "keep" });
});

/**
 * 生产 checkpoint 序列化路径（JsonPlusSerializer）：dumpsTyped 读消息自身的
 * lc_kwargs，loadsTyped 拿同一份 kwargs 走构造器 revive——`new Ctor(lc_kwargs)`
 * 即完整生产循环。归一化后的消息必须循环不变：content 保持字符串、lc_kwargs
 * 不嵌套膨胀（盲展开 `{...message}` 会把旧 lc_kwargs 折进新消息的 lc_kwargs，
 * 逐轮加深一层，深会话 blob O(T²) 增长——评审实证 719→944→1169 字节）。
 */
test("normalized messages stay flat across checkpointer serialize/revive cycles", () => {
  const message = new AIMessage({
    content: [{ type: "text", text: "策略已生成。" }],
    id: "msg-1",
    additional_kwargs: { card: { $type: "race-strategy" } },
  });
  const normalized = normalizeMessageContent(message);
  const revive = (source: BaseMessage): BaseMessage => new (source.constructor as new (fields: Record<string, unknown>) => BaseMessage)(source.lc_kwargs);

  const once = revive(normalized);
  const twice = revive(once);

  assert.equal(once.content, "策略已生成。");
  assert.equal(twice.content, "策略已生成。");
  const flat = JSON.stringify(normalized.lc_kwargs);
  assert.equal(JSON.stringify(twice.lc_kwargs), flat, "lc_kwargs must not grow or nest across revive cycles");
  assert.ok(!flat.includes("lc_kwargs"), "Serializable internals must not leak into the checkpointed kwargs");
});
