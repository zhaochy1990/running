# Go async-job worker: RabbitMQ transport + MySQL state

We are rewriting the async-job worker (currently the dormant Python `stride-job-worker`) in Go for a separate deployment on Tencent Cloud. This ADR fixes its messaging and state architecture. Scope is the **generic job infra only** — enqueue → durable state → consume → dispatch → retry/poison → pipeline advancement — **not** the handlers and **not** the in-process coach-job scheduler (`stridecoachjobs`). The dormant Python worker is unused, so there is no back-compat constraint.

## Decision

- **Transport: RabbitMQ.** Self-hosted open-source first, with a protocol-compatible migration path to **TDMQ for RabbitMQ** (Tencent managed) later — a mostly endpoint/credential swap.
- **State: MySQL (TencentDB), source of truth.** Store-first: write the job row as `queued`, then publish a small **pointer** message (`job_id` + `partition_key`) to RabbitMQ. Full state lives in MySQL; the broker only carries pointers.
- **Concurrency-safe by design, 1 replica by default.** Competing consumers are safe (idempotent state transitions; at-least-once delivery ⇒ handlers must be idempotent). Horizontal scale is a replica-count change, not a redesign. Crashed-worker recovery relies on the broker's ack-timeout/redelivery — no MySQL lease/visibility columns.
- **Retry & poison: DLX + TTL retry queue + poison DLQ.** Work queue + a retry queue whose per-message TTL provides backoff (dead-letters back to the work queue on expiry) + a poison dead-letter queue. `attempts` is counted in MySQL; under the limit → retry-with-backoff, at the limit → poison DLQ + terminal `failed`.
- **Reliability stance:** persistent messages, publisher confirms, manual consumer ack.

## Considered options

- **MySQL-as-queue (no broker):** poll `queued` rows with `SELECT … FOR UPDATE SKIP LOCKED` + a `visible_at`/lease column. Rejected: the operator wants a real broker with a clean Tencent-managed successor, and prefers the broker to own transport semantics (redelivery, delay, dead-lettering) rather than reimplementing them in SQL.
- **RocketMQ / Pulsar:** both have Tencent-managed successors (TDMQ for RocketMQ / TDMQ for Pulsar). Rejected for phase 1: RocketMQ is heavier to self-host with a rougher Go client; Pulsar is the heaviest to self-host (BookKeeper + ZooKeeper). RabbitMQ is the simplest self-host with the best-maintained Go client (`amqp091-go`) and the cleanest job-queue semantics.
- **Plain `nack(requeue=true)` for retries:** rejected — no backoff, tight redelivery loop on persistent failures.

## Consequences

- Two infra pieces to run (broker + DB), like the old Azure Queue + Table split — accepted for the broker's semantics and managed-migration path.
- RabbitMQ lacks native delayed delivery; the `delay_s` enqueue feature needs the `rabbitmq_delayed_message_exchange` plugin (or TTL+DLX). Lightly used, acceptable.
- Handlers **must** be idempotent because delivery is at-least-once.
