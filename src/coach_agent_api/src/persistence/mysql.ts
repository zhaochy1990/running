/**
 * MySQL bootstrap helpers for the coach persistence DB. The single
 * implementation lives in `@stride/coach-agent-worker` (AGENTS.md "不要重复造
 * 轮子"); the API re-exports it so both services configure the DB identically.
 */
export { createPool, ensureDatabase } from "@stride/coach-agent-worker";
