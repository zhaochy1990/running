import { afterEach, describe, expect, it, vi } from "vitest";

import { apiUrl } from "../apiRouting";

const TENCENT = "https://api.stride-running.cn";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apiUrl (frontend static container → Caddy-internal API base)", () => {
  it("stays relative when no API origin is baked in (local dev / Vite proxy)", () => {
    expect(apiUrl("GET", "/api/users/me/profile")).toBe("/api/users/me/profile");
    expect(apiUrl("POST", "/api/auth/login")).toBe("/api/auth/login");
  });

  it("preserves the query string", () => {
    const path = "/api/abc/activities?date_from=2026-08-01&limit=200";
    expect(apiUrl("GET", path)).toBe(path);
  });

  it("prepends the baked API origin for every endpoint (prod, cross-origin)", () => {
    vi.stubEnv("VITE_API_BASE_URL", TENCENT);
    expect(apiUrl("GET", "/api/users/me/profile")).toBe(`${TENCENT}/api/users/me/profile`);
    expect(apiUrl("POST", "/api/auth/login")).toBe(`${TENCENT}/api/auth/login`);
  });

  it("strips a trailing slash from the baked origin", () => {
    vi.stubEnv("VITE_API_BASE_URL", `${TENCENT}/`);
    expect(apiUrl("GET", "/api/users/me/profile")).toBe(`${TENCENT}/api/users/me/profile`);
  });
});
