import { create } from "zustand";
import { setAuthUser, clearAuthUser } from "../telemetry/appInsights";
import { apiUrl } from "../lib/apiRouting";

// Auth calls the API gateway (api.stride-running.cn) directly — the SPA's API
// origin is baked via VITE_API_BASE_URL (src/lib/apiRouting.ts). In local dev
// the origin is empty so requests stay relative and the Vite proxy forwards
// them server-side. VITE_AUTH_CLIENT_ID (sent as X-Client-Id) is baked in.
const CLIENT_ID = import.meta.env.VITE_AUTH_CLIENT_ID || "";

interface JwtPayload {
  sub: string;
  exp: number;
  role?: string;
}

function decodeJwt(token: string): JwtPayload {
  const base64Url = token.split(".")[1];
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const json = decodeURIComponent(
    atob(base64)
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join(""),
  );
  return JSON.parse(json);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function clearBrowserSession() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  void clearAuthUser();
  sessionStorage.clear();
}

async function refreshAccessToken(): Promise<string> {
  const refreshToken = sessionStorage.getItem("refresh_token");
  if (!refreshToken) throw new Error("No refresh token");

  const res = await fetch(apiUrl("POST", `/api/auth/refresh`), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client-Id": CLIENT_ID },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) throw new Error("Refresh failed");

  const data = await res.json();
  sessionStorage.setItem("access_token", data.access_token);
  sessionStorage.setItem("refresh_token", data.refresh_token);
  return data.access_token as string;
}

function scheduleTokenRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const token = sessionStorage.getItem("access_token");
  if (!token) return;

  try {
    const payload = decodeJwt(token);
    const msUntilExpiry = payload.exp * 1000 - Date.now();
    const delay = Math.max(msUntilExpiry - 60_000, 1_000);
    refreshTimer = setTimeout(async () => {
      try {
        await refreshAccessToken();
        scheduleTokenRefresh();
      } catch {
        /* will redirect on next 401 */
      }
    }, delay);
  } catch {
    /* invalid token */
  }
}

interface AuthState {
  accessToken: string | null;
  userId: string | null;
  isAuthenticated: boolean;
  hydrated: boolean;
  login: (email: string, password: string) => Promise<void>;
  registerSuccess: (access_token: string, refresh_token: string) => void;
  sendSmsCode: (phone: string) => Promise<void>;
  loginWithPhone: (phone: string, code: string, inviteCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  clearSession: () => void;
  hydrate: () => void;
}

export function useUserId(): string | null {
  return useAuthStore((s) => s.userId);
}

// Read auth state from sessionStorage synchronously so the very first render
// has the correct isAuthenticated value. If this ran in a useEffect (deferred
// to after first render) ProtectedRoute would redirect to /login first and
// the original deep-link URL would be lost on refresh.
function readPersistedAuth(): Pick<AuthState, "accessToken" | "userId" | "isAuthenticated" | "hydrated"> {
  if (typeof window === "undefined") {
    return { accessToken: null, userId: null, isAuthenticated: false, hydrated: true };
  }
  const accessToken = sessionStorage.getItem("access_token");
  const refreshToken = sessionStorage.getItem("refresh_token");
  if (accessToken && refreshToken) {
    try {
      const payload = decodeJwt(accessToken);
      if (payload.exp * 1000 > Date.now()) {
        return {
          accessToken,
          userId: payload.sub,
          isAuthenticated: true,
          hydrated: true,
        };
      }
    } catch {
      /* fall through to unauthenticated */
    }
  }
  return { accessToken: null, userId: null, isAuthenticated: false, hydrated: true };
}

const initialAuth = readPersistedAuth();

// Persist a freshly issued token pair and flip the store into the authenticated
// state. `login`, `registerSuccess` and `loginWithPhone` all do exactly this,
// so it lives in one place.
function applySession(set: (partial: Partial<AuthState>) => void, accessToken: string, refreshToken: string) {
  const payload = decodeJwt(accessToken);
  sessionStorage.setItem("access_token", accessToken);
  sessionStorage.setItem("refresh_token", refreshToken);
  set({
    accessToken,
    userId: payload.sub,
    isAuthenticated: true,
    hydrated: true,
  });
  void setAuthUser(payload.sub);
  scheduleTokenRefresh();
}

export const useAuthStore = create<AuthState>((set) => ({
  ...initialAuth,

  login: async (email: string, password: string) => {
    const res = await fetch(apiUrl("POST", `/api/auth/login`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": CLIENT_ID },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw { status: res.status, error: data.error };
    }

    const { access_token, refresh_token } = await res.json();
    applySession(set, access_token, refresh_token);
  },

  registerSuccess: (access_token: string, refresh_token: string) => {
    applySession(set, access_token, refresh_token);
  },

  sendSmsCode: async (phone: string) => {
    const res = await fetch(apiUrl("POST", `/api/auth/sms/send`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": CLIENT_ID },
      // login_only: the web login form must not silently register an unbound
      // phone — the backend rejects it with phone_not_registered so the UI can
      // guide the user to sign up instead.
      body: JSON.stringify({ phone, login_only: true }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { status: res.status, error: data.error };
    // The endpoint answers {status:"ok"}. A non-JSON 200 (e.g. a misrouted
    // proxy serving the SPA fallback) must not be mistaken for a sent code —
    // otherwise the UI starts a countdown that never delivered an SMS.
    if (data.status !== "ok") throw { status: res.status, error: "unexpected_response" };
  },

  loginWithPhone: async (phone: string, code: string, inviteCode?: string) => {
    const body: { phone: string; code: string; invite_code?: string } = { phone, code };
    if (inviteCode) body.invite_code = inviteCode;

    const res = await fetch(apiUrl("POST", `/api/auth/sms/verify`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": CLIENT_ID },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw { status: res.status, error: data.error };
    }

    const { access_token, refresh_token } = await res.json();
    applySession(set, access_token, refresh_token);
  },

  logout: async () => {
    const refreshToken = sessionStorage.getItem("refresh_token");

    if (refreshToken) {
      try {
        await fetch(apiUrl("POST", `/api/auth/logout`), {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Client-Id": CLIENT_ID },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch {
        /* best-effort: server-side revocation may fail; local cleanup still runs */
      }
    }

    clearBrowserSession();
    set({
      accessToken: null,
      userId: null,
      isAuthenticated: false,
      hydrated: true,
    });
  },

  clearSession: () => {
    clearBrowserSession();
    set({
      accessToken: null,
      userId: null,
      isAuthenticated: false,
      hydrated: true,
    });
  },

  hydrate: () => {
    const accessToken = sessionStorage.getItem("access_token");
    const refreshToken = sessionStorage.getItem("refresh_token");

    if (accessToken && refreshToken) {
      try {
        const payload = decodeJwt(accessToken);
        if (payload.exp * 1000 > Date.now()) {
          set({
            accessToken,
            userId: payload.sub,
            isAuthenticated: true,
            hydrated: true,
          });
          void setAuthUser(payload.sub);
          scheduleTokenRefresh();
          return;
        }
      } catch {
        /* invalid token, fall through */
      }
    }

    clearBrowserSession();
    set({
      accessToken: null,
      userId: null,
      isAuthenticated: false,
      hydrated: true,
    });
  },
}));

export { refreshAccessToken };
