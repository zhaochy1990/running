import { createContext, useContext } from "react";
import type { OnboardingSyncView } from "../api";

// Context + hook live apart from the provider component (same split as
// UserContextValue.ts) so react-refresh keeps the component file pure.
export interface OnboardingSyncStatusValue {
  // Latest session view, or null when no session exists / switches are off /
  // it has not been fetched yet.
  view: OnboardingSyncView | null;
  // True while a POST retry is in flight.
  retrying: boolean;
  // Error message from the last retry attempt (cleared on success).
  retryError: string | null;
  // Re-dispatch only the session's unfinished work (server semantics).
  retry: () => Promise<void>;
  // Hide the banner for this page load (gaps summary is dismissible).
  dismiss: () => void;
  dismissed: boolean;
}

export const OnboardingSyncStatusContext = createContext<OnboardingSyncStatusValue | null>(null);

export function useOnboardingSyncStatus(): OnboardingSyncStatusValue {
  const ctx = useContext(OnboardingSyncStatusContext);
  if (!ctx) throw new Error("useOnboardingSyncStatus must be used inside OnboardingSyncStatusProvider");
  return ctx;
}
