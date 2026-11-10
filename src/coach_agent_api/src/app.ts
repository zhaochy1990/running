import type { RaceTargetBindingGateway } from "@stride/coach-agent";
import { getLogger } from "@stride/common";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { type AuthEnv, createAuthMiddleware, createInternalTokenMiddleware, createOptionalAuthMiddleware, type JwtVerifier } from "./auth.js";
import type { CoachInvoker } from "./coach/coachInvoker.js";
import type { RollingScanRunner } from "./coach/rollingScan.js";
import type { CoachDataDeleter } from "./persistence/deletion.js";
import type { LotteryFunnelStore } from "./persistence/lotteryFunnel.js";
import type { LotteryStaffStore } from "./persistence/lotteryStaff.js";
import { registerAdminUserRoutes } from "./routes/adminUsers.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerHistoryRoutes, registerSessionListRoutes, type ThreadHistoryReader, type ThreadSessionReader } from "./routes/history.js";
import {
  type LotteryDrawRouteDeps,
  type LotteryRouteDeps,
  type LotteryVerifyRouteDeps,
  registerLotteryAdminRoutes,
  registerLotteryDrawRoutes,
  registerLotteryPublicRoute,
  registerLotteryVerifyRoutes,
} from "./routes/lottery.js";
import { registerLotteryDashboardRoutes } from "./routes/lotteryDashboard.js";
import { registerLotteryStaffRoutes } from "./routes/lotteryStaff.js";
import { type PlanJobsService, registerPlanJobRoutes } from "./routes/planJobs.js";
import { registerRollingScanRoutes } from "./routes/rollingScan.js";
import { type CoachShareCreateDeps, type CoachShareReadDeps, registerCoachShareReadRoute, registerShareCreateRoute } from "./routes/shares.js";
import { registerSwaggerRoutes } from "./routes/swagger.js";
import type { TurnCoordinator } from "./turn/coordinator.js";
import { createInMemoryTurnCoordinator } from "./turn/index.js";

export interface AppDependencies {
  jwtVerifier: JwtVerifier;
  coachInvoker: CoachInvoker;
  turnCoordinator?: TurnCoordinator;
  /** When provided, chat turns fall back to the thread-persisted race target (#891). */
  threadRaceTargets?: RaceTargetBindingGateway;
  /** When provided, exposes per-session conversation history (GET .../sessions/{id}/messages). */
  checkpointer?: ThreadHistoryReader;
  /** When provided, exposes the deterministic plan-job enqueue/poll endpoints. */
  planJobs?: PlanJobsService;
  /**
   * #858 夜检扫描内部端点（POST /api/internal/coach/rolling-scan）：internalToken
   * 为空不挂载（secrets 未配置的部署整体跳过，配置即生效）。
   */
  rollingScan?: { scan: RollingScanRunner; internalToken: string };
  /** When provided, exposes the admin/self coach-data erasure endpoint. */
  coachDataDeleter?: CoachDataDeleter;
  /** When provided, exposes coach chat sharing (#715): the authed create route (requires `checkpointer`) and the public read route. */
  coachShares?: Omit<CoachShareCreateDeps, "checkpointer"> & CoachShareReadDeps;
  /** When provided, exposes the lottery configuration domain (#863): admin CRUD plus the public landing read. */
  lottery?: LotteryRouteDeps["store"];
  /** When provided, exposes the lottery draw core (#865): POST draw + GET my-result (user-tier auth). */
  lotteryDraw?: LotteryDrawRouteDeps;
  /** When provided, exposes the lottery verify domain (#866): staff lookup + redeem (user-tier auth). */
  lotteryVerify?: LotteryVerifyRouteDeps;
  /** When provided, exposes the #867 admin staff-whitelist management endpoints. */
  lotteryStaff?: LotteryStaffStore;
  /** When provided (with `lottery`), exposes the #867 funnel dashboard read and the public funnel ping. */
  lotteryFunnel?: LotteryFunnelStore;
}

const httpLogger = getLogger("http");

export function createApp(dependencies: AppDependencies): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", requestId());
  app.use("*", async (c, next) => {
    const startedAt = performance.now();
    const fields = () => ({
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      durationMs: Math.round(performance.now() - startedAt),
    });
    try {
      await next();
      httpLogger.info({ ...fields(), status: c.res.status }, "request");
    } catch (error) {
      // Hono's onError composes the error response (500 by default) only after
      // this middleware unwinds, so the status is not on c.res yet.
      httpLogger.error({ ...fields(), status: 500 }, "request failed");
      throw error;
    }
  });

  const turnCoordinator = dependencies.turnCoordinator ?? createInMemoryTurnCoordinator();

  registerHealthRoutes(app);
  registerSwaggerRoutes(app);

  // 公开分享读取（#715）：与 /health 同级注册在 auth 前缀之外，免登录。
  if (dependencies.coachShares) {
    registerCoachShareReadRoute(app, dependencies.coachShares);
  }

  // 抽奖落地页公开读取（#863）：同样注册在 auth 前缀之外，免登录只读展示数据。
  if (dependencies.lottery) {
    registerLotteryPublicRoute(app, { store: dependencies.lottery });
  }

  app.use("/api/users/me/coach/chat", createAuthMiddleware(dependencies.jwtVerifier));

  registerChatRoutes(app, {
    coach: dependencies.coachInvoker,
    turnCoordinator,
    ...(dependencies.threadRaceTargets ? { raceTargets: dependencies.threadRaceTargets } : {}),
  });

  if (dependencies.planJobs) {
    registerPlanJobRoutes(app, {
      planJobs: dependencies.planJobs,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  // #858 夜检扫描内部端点：X-Internal-Token 鉴权（token 未配置不挂载）。
  if (dependencies.rollingScan && dependencies.rollingScan.internalToken !== "") {
    registerRollingScanRoutes(app, {
      scan: dependencies.rollingScan.scan,
      internalAuth: createInternalTokenMiddleware(dependencies.rollingScan.internalToken),
    });
  }

  if (dependencies.checkpointer) {
    app.use("/api/users/me/coach/sessions/*", createAuthMiddleware(dependencies.jwtVerifier));
    app.use("/api/users/me/coach/sessions", createAuthMiddleware(dependencies.jwtVerifier));
    registerSessionListRoutes(app, { checkpointer: dependencies.checkpointer as unknown as ThreadSessionReader });
    registerHistoryRoutes(app, { checkpointer: dependencies.checkpointer });
    // 分享创建落在同一 auth 前缀内（#715）：投影需要 checkpointer，二者同源。
    if (dependencies.coachShares) {
      registerShareCreateRoute(app, {
        store: dependencies.coachShares.store,
        checkpointer: dependencies.checkpointer,
        ...(dependencies.coachShares.wxacode !== undefined ? { wxacode: dependencies.coachShares.wxacode } : {}),
      });
    }
  }

  if (dependencies.coachDataDeleter) {
    registerAdminUserRoutes(app, {
      deleter: dependencies.coachDataDeleter,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  // 抽奖活动配置域（#863）：admin CRUD 一律 auth + admin 双门。
  if (dependencies.lottery) {
    registerLotteryAdminRoutes(app, {
      store: dependencies.lottery,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  // 抽奖核心（#865）：draw / my-result 走用户级 auth（无需 admin）。
  if (dependencies.lotteryDraw) {
    registerLotteryDrawRoutes(app, {
      ...dependencies.lotteryDraw,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  // 核销域（#866）：staff 查询/核销走用户级 auth；openid resolver 未配置时
  // 端点挂载但整体 503（配置即生效，无需发版）。
  if (dependencies.lotteryVerify) {
    registerLotteryVerifyRoutes(app, {
      ...dependencies.lotteryVerify,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  // staff 白名单管理（#867）：增删查全部 admin 双门。
  if (dependencies.lotteryStaff) {
    registerLotteryStaffRoutes(app, {
      store: dependencies.lotteryStaff,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  // 数据看板（#867）：漏斗读 admin 双门；埋点 ping 公开 + 可选归因。
  if (dependencies.lottery && dependencies.lotteryFunnel) {
    registerLotteryDashboardRoutes(app, {
      store: dependencies.lottery,
      events: dependencies.lotteryFunnel,
      auth: createAuthMiddleware(dependencies.jwtVerifier),
      optionalAuth: createOptionalAuthMiddleware(dependencies.jwtVerifier),
    });
  }

  return app;
}
