import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeJwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `header.${encoded}.signature`;
}

describe("authStore auth calls (frontend static container → Caddy-internal API)", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    vi.stubEnv("VITE_AUTH_CLIENT_ID", "app_test");
    vi.stubEnv("VITE_AUTH_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("posts login to the relative /api/auth path when no API origin is baked (local dev / Vite proxy)", async () => {
    const accessToken = makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: accessToken, refresh_token: "refresh-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { useAuthStore } = await import("../authStore");

    await useAuthStore.getState().login("runner@example.test", "password");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": "app_test" },
      body: JSON.stringify({ email: "runner@example.test", password: "password" }),
    });
  });

  it("posts login to the absolute API origin when VITE_API_BASE_URL is baked (prod)", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE_URL", "https://api.stride-running.cn");
    const accessToken = makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: accessToken, refresh_token: "refresh-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { useAuthStore } = await import("../authStore");

    await useAuthStore.getState().login("runner@example.test", "password");

    expect(fetchMock).toHaveBeenCalledWith("https://api.stride-running.cn/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": "app_test" },
      body: JSON.stringify({ email: "runner@example.test", password: "password" }),
    });
  });

  it("posts the phone to /api/auth/sms/send with the X-Client-Id header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { useAuthStore } = await import("../authStore");

    await useAuthStore.getState().sendSmsCode("13800138000");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": "app_test" },
      body: JSON.stringify({ phone: "13800138000", login_only: true }),
    });
  });

  it("throws { status, error } when sms/send is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "sms_send_cooldown" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { useAuthStore } = await import("../authStore");

    await expect(useAuthStore.getState().sendSmsCode("13800138000")).rejects.toEqual({
      status: 429,
      error: "sms_send_cooldown",
    });
  });

  it("rejects a 200 sms/send response that is not the ok envelope", async () => {
    // A misrouted proxy can answer 200 with the SPA's HTML fallback; that must
    // not be mistaken for "code sent" (the UI would start a countdown and then
    // fail at verify).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const { useAuthStore } = await import("../authStore");

    await expect(useAuthStore.getState().sendSmsCode("13800138000")).rejects.toEqual({
      status: 200,
      error: "unexpected_response",
    });
  });

  it("verifies a phone code without invite_code and applies the session", async () => {
    const accessToken = makeJwt({ sub: "user-9", exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: accessToken, refresh_token: "refresh-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { useAuthStore } = await import("../authStore");

    await useAuthStore.getState().loginWithPhone("13800138000", "123456");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sms/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": "app_test" },
      body: JSON.stringify({ phone: "13800138000", code: "123456" }),
    });
    expect(sessionStorage.getItem("access_token")).toBe(accessToken);
    expect(sessionStorage.getItem("refresh_token")).toBe("refresh-token");
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().userId).toBe("user-9");
  });

  it("includes invite_code in the verify body only when non-empty", async () => {
    const accessToken = makeJwt({ sub: "user-9", exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ access_token: accessToken, refresh_token: "refresh-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const { useAuthStore } = await import("../authStore");

    await useAuthStore.getState().loginWithPhone("13800138000", "123456", "INVITE-1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/sms/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": "app_test" },
      body: JSON.stringify({ phone: "13800138000", code: "123456", invite_code: "INVITE-1" }),
    });

    await useAuthStore.getState().loginWithPhone("13800138000", "123456", "");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/auth/sms/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": "app_test" },
      body: JSON.stringify({ phone: "13800138000", code: "123456" }),
    });
  });
});
