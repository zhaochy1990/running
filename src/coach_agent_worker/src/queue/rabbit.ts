import { getLogger } from "@stride/common";
import { type Channel, type ChannelModel, type ConfirmChannel, connect, type Message } from "amqplib";
import type { PlanJobMessage } from "../job/model.js";
import type { QueuePublisher } from "../job/ports.js";
import { decodeMessage, encodeMessage } from "./codec.js";

const logger = getLogger("plan-job/queue");

/**
 * Queue names — deliberately distinct from the Go worker's `stride.jobs`* so a
 * plan-job worker and a Go worker can share the broker without interference.
 * Defaults live in the worker/API configs; declared idempotently at startup
 * (ADR 0030).
 */
export interface QueueTopology {
  work: string;
  retry: string;
  poison: string;
}

/** Owns the lifecycle of one RabbitMQ connection (mirrors Go `mq.Conn`). */
export class PlanJobQueue {
  private readonly conn: ChannelModel;
  private closed = false;

  private constructor(conn: ChannelModel) {
    this.conn = conn;
    conn.once("close", () => {
      this.closed = true;
    });
  }

  static async connect(url: string): Promise<PlanJobQueue> {
    return new PlanJobQueue(await connect(url));
  }

  isHealthy(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      await this.conn.close();
    }
  }

  /** Idempotently declare work/retry/poison; retry dead-letters expiry back to work. */
  async declareTopology(topology: QueueTopology): Promise<void> {
    const ch = await this.openChannel(false);
    try {
      await ch.assertQueue(topology.work, { durable: true });
      await ch.assertQueue(topology.poison, { durable: true });
      await ch.assertQueue(topology.retry, {
        durable: true,
        arguments: { "x-dead-letter-exchange": "", "x-dead-letter-routing-key": topology.work },
      });
    } finally {
      await ch.close();
    }
  }

  /** Open a channel; `confirm = true` enables publisher confirms. */
  async openChannel(confirm: boolean): Promise<Channel> {
    if (this.closed) throw new Error("mq: connection is closed");
    if (confirm) return this.conn.createConfirmChannel();
    return this.conn.createChannel();
  }
}

export class RabbitPublisher implements QueuePublisher {
  private ch: ConfirmChannel | null = null;
  private closed = true;

  private constructor(private readonly topology: QueueTopology) {}

  static async create(queue: PlanJobQueue, topology: QueueTopology): Promise<RabbitPublisher> {
    const ch = (await queue.openChannel(true)) as ConfirmChannel;
    const publisher = new RabbitPublisher(topology);
    publisher.ch = ch;
    publisher.closed = false;
    ch.once("close", () => {
      publisher.closed = true;
      publisher.ch = null;
    });
    return publisher;
  }

  async close(): Promise<void> {
    if (this.ch !== null) {
      await this.ch.close();
    }
  }

  isHealthy(): boolean {
    return !this.closed && this.ch !== null;
  }

  async publishWork(message: PlanJobMessage): Promise<void> {
    await this.publish(this.topology.work, message);
  }

  async publishRetry(message: PlanJobMessage, delayMs: number): Promise<void> {
    await this.publish(this.topology.retry, message, String(delayMs));
  }

  async publishPoison(message: PlanJobMessage): Promise<void> {
    await this.publish(this.topology.poison, message);
  }

  private async publish(routingKey: string, message: PlanJobMessage, expiration?: string): Promise<void> {
    const ch = this.requireChannel();
    ch.publish("", routingKey, encodeMessage(message), {
      contentType: "application/json",
      deliveryMode: 2, // persistent
      ...(expiration !== undefined ? { expiration } : {}),
    });
    try {
      await ch.waitForConfirms();
    } catch (error) {
      throw new Error(`mq: broker nacked publish to ${routingKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private requireChannel(): ConfirmChannel {
    if (this.ch === null || this.closed) {
      throw new Error("mq: publisher channel is closed");
    }
    return this.ch;
  }
}

export type DeliveryHandler = (message: PlanJobMessage) => Promise<void>;

/** Consumes the work queue with manual acks (mirrors Go `mq.Consumer`). */
export class RabbitConsumer {
  private constructor(private readonly queue: PlanJobQueue) {}

  static create(queue: PlanJobQueue): RabbitConsumer {
    return new RabbitConsumer(queue);
  }

  /**
   * Consume until the connection closes. A rejected `handle` (infra fault) is
   * nacked with requeue so the broker redelivers when the fault clears; an
   * undecodable pointer is rejected without requeue (it can never be handled).
   */
  async run(topology: QueueTopology, prefetch: number, handle: DeliveryHandler): Promise<never> {
    const ch = await this.queue.openChannel(false);
    await ch.prefetch(prefetch);
    await ch.assertQueue(topology.work, { durable: true });
    await ch.consume(
      topology.work,
      (message) => {
        if (message === null) return; // consumer cancelled
        void this.handleDelivery(ch, message, handle);
      },
      { noAck: false },
    );
    logger.info({ queue: topology.work, prefetch }, "plan-job consumer started");
    return await new Promise((_resolve, reject) => {
      ch.on("close", () => reject(new Error("mq: consumer channel closed")));
      ch.on("error", (error) => reject(new Error(`mq: consumer channel error: ${error instanceof Error ? error.message : String(error)}`)));
    });
  }

  private async handleDelivery(ch: Channel, raw: Message, handle: DeliveryHandler): Promise<void> {
    let message: PlanJobMessage;
    try {
      message = decodeMessage(raw.content);
    } catch (error) {
      logger.warn({ bytes: raw.content.byteLength, error: String(error) }, "rejecting undecodable plan-job message");
      void ch.reject(raw, false);
      return;
    }
    logger.info({ jobId: message.jobId, userId: message.userId }, "plan-job message received");
    try {
      await handle(message);
      void ch.ack(raw);
    } catch (error) {
      logger.warn({ jobId: message.jobId, error: String(error) }, "plan-job handler faulted, requeueing");
      void ch.nack(raw, false, true);
    }
  }
}
