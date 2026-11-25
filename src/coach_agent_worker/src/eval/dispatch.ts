import { getLogger } from "@stride/common";
import { type EvalApiClient, MissingExecutionError, StaleLeaseError } from "./client.js";
import type { EvalExecutionMessage, ExecutionInput, GenerateResult } from "./protocol.js";

const logger = getLogger("plan-eval/dispatch");

export interface EvalDispatcherDeps {
  client: EvalApiClient;
  agentVersion: string;
  workerId: string;
  generate(input: ExecutionInput, signal: LeaseSignal): Promise<GenerateResult>;
  lease: { renewIntervalMs: number; busyMaxWaitMs: number };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 生成期间租约是否仍归本 worker；易主后本次结果作废。 */
export interface LeaseSignal {
  readonly lost: boolean;
}

/**
 * 处理一条执行消息直到它可以被确认为止（devops#1046/#1055）：
 *
 * - 领取到租约 → 生成（期间定时续租）→ 回传 → 拿到持久化收据后返回，调用方 ACK；
 * - 读到已终结结果或执行项不存在 → 直接返回（ACK，不重复生成）——覆盖“回传响应丢失后
 *   broker 重投”：重投的消息一领取就看到终态；
 * - 别的 worker 持有有效租约 → 保持未确认并有界退避重试，超过上限抛错交还 broker；
 * - 租约失效（续租/回传被拒）→ 丢弃未提交结果，交还 broker 重投；
 * - 其余（测评 API 不可达等基础设施故障）→ 抛错，调用方 nack 重投。
 */
export class EvalDispatcher {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: EvalDispatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async process(message: EvalExecutionMessage): Promise<void> {
    const id = message.snapshot_execution_id;
    const waitDeadline = this.now() + this.deps.lease.busyMaxWaitMs;
    for (;;) {
      const claim = await this.deps.client.claim(id, this.deps.agentVersion, this.deps.workerId);
      if (claim.status === "terminal" || claim.status === "missing") {
        logger.info({ snapshotExecutionId: id, status: claim.status }, "snapshot execution already settled, acknowledging duplicate delivery");
        return;
      }
      if (claim.status === "busy") {
        const remaining = waitDeadline - this.now();
        if (remaining <= 0) throw new Error(`lease of snapshot execution ${id} stayed busy for ${this.deps.lease.busyMaxWaitMs}ms`);
        await this.sleep(Math.min(claim.retry_after_ms, remaining));
        continue;
      }
      await this.runLeased(id, claim.lease_epoch, claim.input);
      return;
    }
  }

  private async runLeased(id: string, epoch: number, input: ExecutionInput): Promise<void> {
    const lease = { lost: false };
    const renewTimer = setInterval(() => {
      void this.deps.client.renew(id, epoch).catch((error: unknown) => {
        if (error instanceof StaleLeaseError) {
          lease.lost = true;
          logger.warn({ snapshotExecutionId: id, epoch }, "lease taken over by another worker; dropping this attempt");
        } else {
          // 测评 API 抖动：下一次续租再试，租约期限内不会因此易主。
          logger.warn({ snapshotExecutionId: id, epoch, error: String(error) }, "lease renew failed");
        }
      });
    }, this.deps.lease.renewIntervalMs);
    renewTimer.unref?.();
    try {
      const result = await this.deps.generate(input, lease);
      if (lease.lost) throw new StaleLeaseError(id, "renew");
      const receipt = await this.deps.client.submit(id, epoch, result);
      logger.info({ snapshotExecutionId: id, receipt }, "generate result persisted, acknowledging");
    } catch (error) {
      if (error instanceof MissingExecutionError) {
        logger.warn({ snapshotExecutionId: id, epoch }, "snapshot execution no longer exists");
        return;
      }
      throw error;
    } finally {
      clearInterval(renewTimer);
    }
  }
}
