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
});
