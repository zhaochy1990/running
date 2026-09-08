// 轻量 SSE（Server-Sent Events）分块解析器（小程序用）。
//
// coach 后端的流式端点经 Hono `stream.writeSSE` 输出：
//   event: status\n       data: {"turn_id":"...","phase":"...","tool_status":"..."}\n\n
//   event: text_delta\n   data: {"turn_id":"...","delta":"..."}\n\n
//   event: done\n         data: {"turn_id":"...","status":"completed","message":"..."}\n\n
//   event: error\n        data: {"turn_id":"...","code":"...","message":"..."}\n\n
//
// wx.request 开启 enableChunked 后 onChunkReceived 每次回调一段 ArrayBuffer —— 每次
// 收到的字节是前一段之后的新数据，因此这里按字节累积缓存，只在事件边界（空行
// \n\n / \r\n\r\n 到达）才把整块解码成字符串。事件终止符是单个 ASCII 字节，永不落进
// 多字节 UTF-8 码元中间，所以「块完整才解码」天然避免跨 chunk 的中文/换行被切断。
// 不用 TextDecoder：小程序基础库不保证它存在，这里手写一个最小解码器。

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** 把一段字节解码为字符串。块边界由调用方保证完整；非起始/截断字节按 U+FFFD 降级，不中断流。 */
function utf8Decode(bytes: number[]): string {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i] & 0xff;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    let cp = 0;
    let extra = 0;
    if ((b & 0xe0) === 0xc0) {
      cp = b & 0x1f;
      extra = 1;
    } else if ((b & 0xf0) === 0xe0) {
      cp = b & 0x0f;
      extra = 2;
    } else if ((b & 0xf8) === 0xf0) {
      cp = b & 0x07;
      extra = 3;
    } else {
      // 非 UTF-8 起始字节，原样落下。
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    if (i + extra >= n) {
      // 结尾截断（非终止符引发的块，flush 兜底路径）。
      out += '�';
      break;
    }
    let ok = true;
    for (let k = 1; k <= extra; k += 1) {
      const c = bytes[i + k] & 0xff;
      if ((c & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok) {
      out += String.fromCharCode(b);
      i += 1;
      continue;
    }
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '�';
    } else {
      out += String.fromCodePoint(cp);
    }
    i += extra + 1;
  }
  return out;
}

/** 把字符串按 UTF-8 编码回字节（旧基础库降级路径：整段 SSE 文本一次喂入时复用同一套字节级切分）。 */
function utf8Encode(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

type ByteSource = ArrayBuffer | Uint8Array | number[] | string;

function toBytes(data: ByteSource): number[] {
  if (typeof data === 'string') return utf8Encode(data);
  if (data instanceof Uint8Array) return Array.from(data);
  if (data instanceof ArrayBuffer) return Array.from(new Uint8Array(data));
  return data;
}

/** 找到下一个事件终止空行，返回「终止符之后」的索引；没有则返回 -1。 */
function findEventEnd(buf: number[]): number {
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i + 4;
  }
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 10 && buf[i + 1] === 10) return i + 2;
  }
  return -1;
}

/** 解析一个完整的事件块（不含终止空行）为 { event, data, id }。 */
function parseEventBlock(block: number[]): SseEvent {
  const text = utf8Decode(block).replace(/\r\n/g, '\n');
  let event = '';
  let id = '';
  const dataLines: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // 注释行
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }
  return { event, data: dataLines.join('\n'), id: id || undefined };
}

/**
 * 增量 SSE 解析器。跨 chunk 累积字节，命中事件边界时产出完整事件。
 * `feed()` 喂一段新数据，返回本次新解析出的事件数组（按到达顺序）。
 */
export class SseParser {
  private buffer: number[] = [];

  feed(data: ByteSource): SseEvent[] {
    const bytes = toBytes(data);
    if (bytes.length === 0) return [];
    this.buffer.push(...bytes);
    const events: SseEvent[] = [];
    for (;;) {
      const end = findEventEnd(this.buffer);
      if (end < 0) break;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      events.push(parseEventBlock(block));
    }
    return events;
  }

  /** 流结束（连接关闭）时调用：把未以空行收尾的残余字节解析为一个事件。 */
  flush(): SseEvent[] {
    if (this.buffer.length === 0) return [];
    const block = this.buffer.slice(0);
    this.buffer = [];
    return [parseEventBlock(block)];
  }
}

// 自检：devtools 控制台可调 `demoSse()` 断言通过；亦是本模块的 runnable check。
export function demoSse(): void {
  const parser = new SseParser();
  const collect: SseEvent[] = [];

  // 构造两条事件：status + done。故意把「\n\n」边界和一个中文多字节码元（'正' 0xE6 0xAD 0xA3）
  // 切在 chunk 中间，验证跨 chunk 不丢事件、不炸码元。
  const raw =
    'event: status\n' +
    'data: {"turn_id":"t1","phase":"analyzing_intent"}\n\n' +
    'event: done\n' +
    'data: {"turn_id":"t1","status":"completed","message":"你好，正在分析"}\n\n';

  const bytes = utf8Encode(raw);
  // 在每个字节边界喂一次（最极端切分）。
  for (const b of bytes) for (const ev of parser.feed([b])) collect.push(ev);

  if (collect.length !== 2) throw new Error(`demoSse: expect 2 events, got ${collect.length}`);
  if (collect[0].event !== 'status') throw new Error(`demoSse: first event ${collect[0].event}`);
  if (JSON.parse(collect[0].data).phase !== 'analyzing_intent') throw new Error('demoSse: phase mismatch');
  if (collect[1].event !== 'done') throw new Error(`demoSse: second event ${collect[1].event}`);
  const done = JSON.parse(collect[1].data);
  if (done.message !== '你好，正在分析') throw new Error(`demoSse: message mismatch ${done.message}`);

  // flush 兜底：无终止符的残余。
  const p2 = new SseParser();
  const evs = p2.feed('data: {"a":1}');
  if (evs.length !== 0) throw new Error('demoSse: un-terminated data should not emit');
  const flushed = p2.flush();
  if (flushed.length !== 1 || flushed[0].data !== '{"a":1}') throw new Error('demoSse: flush mismatch');
}
