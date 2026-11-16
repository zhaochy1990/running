import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, getOnboardingSyncSession, postOnboardingComplete, postOnboardingSyncSession } from "../../api";
import { SESSION_POLL_MS } from "../../onboardingSync/sessionModel";

// First-sync-session submit step (devops#1014 T10). Unlike the legacy
// full-run flow this step does NOT start or track a pipeline: it asks the
// server to atomically create (or claim — refresh, retry, another device)
// the session, and as soon as the server reports shell_ready (the session
// AND its dispatch intent are durably persisted) it completes onboarding
// profile-only — the session's recent run is never submitted to the legacy
// finalizer — and enters the app, where the global banner keeps showing the
// server-side progress. Until that confirmation the UI must not claim any
// background sync is running (创建失败不假报后台运行).
interface Props {
  userId: string;
  // Fired when the server rejects the session entry (403): the switches are
  // off, so the parent should fall back to the legacy full-run flow.
  onDisabled: () => void;
}

type Phase = "creating" | "adopting" | "entering" | "create-failed" | "enter-failed";

export default function SessionSubmitStep({ userId, onDisabled }: Props) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("creating");
  const [error, setError] = useState("");
  const mountedRef = useRef(false);
  const userIdRef = useRef(userId);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    userIdRef.current = userId;
    return () => {
      mountedRef.current = false;
    };
  }, [userId]);

  // Profile-only completion: no run_id — binding and completion stay
  // independent, and the finalizer's legacy run verification is never fed a
  // session-owned recent run.
  const enterApp = useCallback(
    async (expectedUserId: string, generation: number) => {
      setPhase("entering");
      setError("");
      try {
        const result = await postOnboardingComplete();
        if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation) return;
        if (!result.ok) {
          setPhase("enter-failed");
          setError(result.data.error || result.data.detail || "无法完成初始化，请重试。");
          return;
        }
        navigate("/", { replace: true });
      } catch {
        if (mountedRef.current && userIdRef.current === expectedUserId && generationRef.current === generation) {
          setPhase("enter-failed");
          setError("无法完成初始化，请检查网络后重试。");
        }
      }
    },
    [navigate],
  );

  // A create that returned before shell_ready (e.g. waiting_legacy: the
  // server is adopting an in-flight legacy full sync) is NOT a failure — poll
  // the read-only view until the session is durably dispatched, then enter.
  const waitForShellReady = useCallback(
    (expectedUserId: string, generation: number) => {
      setPhase("adopting");
      const tick = async () => {
        try {
          const view = await getOnboardingSyncSession();
          if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation) return;
          if (view.shell_ready) {
            void enterApp(expectedUserId, generation);
            return;
          }
          window.setTimeout(tick, SESSION_POLL_MS);
        } catch {
          if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation) return;
          window.setTimeout(tick, SESSION_POLL_MS);
        }
      };
      window.setTimeout(tick, SESSION_POLL_MS);
    },
    [enterApp],
  );

  const createSession = useCallback(
    async (expectedUserId = userId, generation = generationRef.current) => {
      setPhase("creating");
      setError("");
      try {
        const result = await postOnboardingSyncSession(false);
        if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation) return;
        if (result.status === 403) {
          // The master/rollout switch is off: the session entry does not
          // exist for this client — run the legacy flow instead.
          onDisabled();
          return;
        }
        if (!result.ok) {
          // Creation failed: honestly report it. Nothing is running in the
          // background and nothing was persisted, so retry just re-creates.
          setPhase("create-failed");
          setError(result.data.error === "no_watch_provider" ? "尚未绑定手表，请返回上一步完成绑定。" : "同步任务创建失败，请重试。");
          return;
        }
        if (result.data.shell_ready) {
          void enterApp(expectedUserId, generation);
        } else {
          waitForShellReady(expectedUserId, generation);
        }
      } catch (err) {
        if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation) return;
        if (err instanceof ApiError && err.status === 403) {
          onDisabled();
          return;
        }
        setPhase("create-failed");
        setError("网络错误，同步任务创建失败，请重试。");
      }
    },
    [enterApp, onDisabled, userId, waitForShellReady],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    void createSession(userId, generation);
    // createSession is a stable-per-user callback; the generation ref guards
    // the async chains across StrictMode double-mounts.
  }, [createSession, userId]);

  const working = phase === "creating" || phase === "adopting" || phase === "entering";

  return (
    <div className="space-y-6" data-testid="session-submit-step">
      <div>
        <h2 className="text-lg font-bold text-text-primary">{phase === "create-failed" ? "同步任务创建失败" : "正在准备你的训练数据"}</h2>
        <p className="mt-1 text-sm text-text-muted">
          {phase === "create-failed"
            ? "后台没有正在运行的同步任务，不会重复导入数据。"
            : phase === "adopting"
              ? "正在接管已有的首次同步任务，进度不会丢失。"
              : "已创建可靠的首次同步任务后即进入首页；近期数据会率先可用，历史数据在后台补齐。"}
        </p>
      </div>

      <ol className="space-y-3" aria-label="首次同步准备">
        <li className="rounded-lg border border-border-subtle bg-bg-base p-4">
          <div className="flex gap-3">
            <span
              aria-hidden="true"
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                phase === "create-failed" ? "border-red-500 text-red-400" : working ? "border-accent-green text-accent-green animate-pulse" : "border-accent-green bg-accent-green text-bg-base"
              }`}
            >
              {phase === "create-failed" ? "!" : "•"}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">
                创建首次同步任务{" "}
                <span className="text-text-muted">
                  · {phase === "create-failed" ? "失败" : phase === "creating" ? "进行中" : "已就绪"}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-text-muted">服务端原子创建或复用你当前手表绑定的同步任务</p>
            </div>
          </div>
        </li>
        <li className="rounded-lg border border-border-subtle bg-bg-base p-4">
          <div className="flex gap-3">
            <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border-subtle text-xs text-text-muted">
              ○
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">近期数据与历史补齐 <span className="text-text-muted">· 进入首页后查看</span></p>
              <p className="mt-0.5 text-xs text-text-muted">首页顶部会持续显示同步进度、覆盖范围与缺项，可随时收起</p>
            </div>
          </div>
        </li>
      </ol>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {phase === "create-failed" && (
        <button
          type="button"
          onClick={() => void createSession()}
          className="w-full rounded-lg bg-accent-green px-4 py-2 text-sm font-medium text-bg-base transition-colors hover:bg-accent-green/90"
        >
          重试创建
        </button>
      )}

      {phase === "enter-failed" && (
        <button
          type="button"
          onClick={() => void enterApp(userIdRef.current, generationRef.current)}
          className="w-full rounded-lg bg-accent-green px-4 py-2 text-sm font-medium text-bg-base transition-colors hover:bg-accent-green/90"
        >
          重试进入 STRIDE
        </button>
      )}

      {working && (
        <div className="flex items-center justify-center py-2" aria-live="polite">
          <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}
