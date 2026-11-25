import { getLogger } from "@stride/common";
import type { Channel, Message } from "amqplib";
import type { PlanJobQueue } from "../queue/rabbit.js";
import { decodeExecutionMessage } from "./codec.js";
import type { EvalExecutionMessage } from "./protocol.js";

const logger = getLogger("plan-eval/consumer");

export type EvalDeliveryHandler = (message: EvalExecutionMessage) => Promise<void>;

/**
 * 一条投递的确认规则（devops#1046/#1055）：处理器正常返回 = 已拿到持久化收据或读到终态，
 * ACK；抛错 = 基础设施故障，退避后 nack 重投，broker 在故障清除后重新投递；解不出来的
 * 指针永远处理不了，直接丢弃。
 */
export async function handleEvalDelivery(
  ch: Pick<Channel, "ack" | "nack" | "reject">,
  raw: Message,
  handle: EvalDeliveryHandler,
  faultBackoffMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let message: EvalExecutionMessage;
  try {
    message = decodeExecutionMessage(raw.content);
  } catch (error) {
    logger.warn({ bytes: raw.content.byteLength, error: String(error) }, "rejecting undecodable plan-eval message");
    void ch.reject(raw, false);
    return;
  }
  const snapshotExecutionId = message.snapshot_execution_id;
  logger.info({ snapshotExecutionId }, "plan-eval message received");
  try {
    await handle(message);
    void ch.ack(raw);
  } catch (error) {
    logger.warn({ snapshotExecutionId, error: String(error) }, "plan-eval handler faulted, requeueing after backoff");
    await sleep(faultBackoffMs);
    void ch.nack(raw, false, true);
  }
}

/** 消费本 Agent 版本的执行队列直到连接关闭（手动确认，与生产模式的 `RabbitConsumer` 同一套生命周期）。 */
export class EvalConsumer {
  private constructor(
    private readonly queue: PlanJobQueue,
    private readonly queueName: string,
  ) {}

  static create(queue: PlanJobQueue, queueName: string): EvalConsumer {
    return new EvalConsumer(queue, queueName);
  }

  async run(prefetch: number, faultBackoffMs: number, handle: EvalDeliveryHandler): Promise<never> {
    const ch = await this.queue.openChannel(false);
    await ch.prefetch(prefetch);
    // 测评 API 负责建队；这里幂等重申，本地单跑 worker 时不必先建拓扑。
    await ch.assertQueue(this.queueName, { durable: true });
    await ch.consume(
      this.queueName,
      (message) => {
        if (message === null) return; // consumer cancelled
        void handleEvalDelivery(ch, message, handle, faultBackoffMs, (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      },
      { noAck: false },
    );
    logger.info({ queue: this.queueName, prefetch }, "plan-eval consumer started");
    return await new Promise((_resolve, reject) => {
      ch.on("close", () => reject(new Error("mq: consumer channel closed")));
      ch.on("error", (error) => reject(new Error(`mq: consumer channel error: ${error instanceof Error ? error.message : String(error)}`)));
    });
  }
}
