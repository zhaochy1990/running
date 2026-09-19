import { useEffect, useState, type ReactNode } from "react";
import { getAuthUser } from "../api";
import PhoneBindModal from "./PhoneBindModal";

// Renders children plus an optional phone-bind modal. Mounted inside
// OnboardingGate, so it only runs once the app is actually shown (new users
// finish onboarding first) and only for authenticated users. When the auth
// identity has no phone, the modal appears; skipping hides it for this session
// and the next app entry (page load) re-checks and reminds again until bound.
// A failed profile fetch must NOT be treated as "no phone" — a transient error
// would otherwise bounce an already-bound user into the modal.
export default function PhoneBindPrompt({ children }: { children: ReactNode }) {
  const [phoneState, setPhoneState] = useState<"loading" | "bound" | "unbound" | "error">("loading");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAuthUser()
      .then((info) => {
        if (cancelled) return;
        setPhoneState(info.phone ? "bound" : "unbound");
      })
      .catch(() => {
        if (!cancelled) setPhoneState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showModal = phoneState === "unbound" && !dismissed;

  return (
    <>
      {children}
      <PhoneBindModal
        open={showModal}
        currentPhone={null}
        onClose={() => setDismissed(true)}
        onBound={() => setDismissed(true)}
        secondaryLabel="稍后再说"
      />
    </>
  );
}
