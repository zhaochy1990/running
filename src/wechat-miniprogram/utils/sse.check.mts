/** SSE 流式解析自检：`node utils/sse.check.mts`。 */
import { strict as assert } from 'node:assert';
import { demoSse, SseParser } from './sse.ts';

// 保留原有逐字节、中文跨块和 flush 的基本校验。
demoSse();

// 一次收到大块数据（或旧基础库一次返回完整字符串）不能因参数展开而栈溢出。
const message = `${'a'.repeat(256 * 1024)}你好🏃`;
const payload = JSON.stringify({ message });
const prefix = 'event: done\ndata: ';
const suffix = '\n\n';
const raw = prefix + payload + suffix;
const bytes = new TextEncoder().encode(raw);

function checkDone(events: ReturnType<SseParser['feed']>): void {
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'done');
  assert.deepEqual(JSON.parse(events[0].data), { message });
}

checkDone(new SseParser().feed(raw));
checkDone(new SseParser().feed(bytes));
checkDone(new SseParser().feed(bytes.buffer));
checkDone(new SseParser().feed(Array.from(bytes)));

// 在已有缓冲上追加大块数据，事件结束符和 UTF-8 字节仍可跨块。
const parser = new SseParser();
assert.deepEqual(parser.feed(prefix), []);
const tail = new TextEncoder().encode(payload + suffix);
const split = tail.length - suffix.length - 2;
assert.deepEqual(parser.feed(tail.slice(0, split)), []);
assert.deepEqual(parser.feed(tail.slice(split, -1)), []);
checkDone(parser.feed(tail.slice(-1)));
assert.deepEqual(parser.flush(), []);

console.log('sse.check: all assertions passed');
