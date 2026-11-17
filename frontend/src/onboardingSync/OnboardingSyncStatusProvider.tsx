import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getOnboardingSyncSession, postOnboardingSyncSession, type OnboardingSyncView } from "../api";
import { OnboardingSyncStatusContext } from "./OnboardingSyncStatusContext";
import { SESSION_POLL_MS, isSessionTerminal } from "./sessionModel";

// Global first-sync session status (devops#1014): one read-only GET poller
// shared by every page. It never creates a session (creation happens once at
// the onboarding submit step) and never writes anything — background progress
// survives navigation, refresh and device switches because the worker is
// server-side; this provider only observes it.
export function OnboardingSyncStatusProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<OnboardingSyncView | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Whether the poll loop should keep running. Starts true (discover an
  // existing session — e.g. user re-entering from another device); flips off
  // on 404 (no session), 403 (switches off — original disable semantics) or
  // once the session reaches a terminal state.
  const [polling, setPolling] = useState(true);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const poll = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const next = await getOnboardingSyncSession();
      if (!mountedRef.current) return;
      setView(next);
      if (isSessionTerminal(next.state)) setPolling(false);
    } catch (err) {
      if (!mountedRef.current) return;
      // Duck-typed status (ApiError and transport failures alike): 404 = no
      // session exists (pre-session onboarding, old users), 403 = the entry
      // points are switched off. Either way the banner simply never appears
      // and the legacy behavior keeps its original semantics.
      const status = (err as { status?: unknown })?.status;
      if (status === 404 || status === 403) {
        setView(null);
        setPolling(false);
        return;
      }
      // Transient errors keep the last view; the next tick retries.
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!polling) return undefined;
    void poll();
    const id = window.setInterval(() => void poll(), SESSION_POLL_MS);
    return () => window.clearInterval(id);
  }, [polling, poll]);

  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const next = await postOnboardingSyncSession(true);
      if (!mountedRef.current) return;
      if (next.ok) {
        setView(next.data);
        setDismissed(false);
        if (!isSessionTerminal(next.data.state)) setPolling(true);
      } else {
        setRetryError("重试失败，请稍后再试。");
      }
    } catch {
      if (mountedRef.current) setRetryError("网络错误，重试失败。");
    } finally {
      if (mountedRef.current) setRetrying(false);
    }
  }, [retrying]);

  const dismiss = useCallback(() => setDismissed(true), []);

  return (
    <OnboardingSyncStatusContext.Provider value={{ view, retrying, retryError, retry, dismiss, dismissed }}>
      {children}
    </OnboardingSyncStatusContext.Provider>
  );
}
