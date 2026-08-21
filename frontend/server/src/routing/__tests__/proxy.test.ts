import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyToUpstream } from "../../proxy.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proxyToUpstream", () => {
  it("forwards pathname + query to the upstream origin and strips Host", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    const req = new Request("http://web.local/api/abc/activities?page=2", {
      method: "GET",
      headers: { host: "web.local", authorization: "Bearer t", "x-client-id": "app_test" },
    });

    await proxyToUpstream(req, "https://stride-app.example");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe("https://stride-app.example/api/abc/activities?page=2");
    const headers = new Headers(init.headers);
    expect(headers.get("host")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer t");
    expect(headers.get("x-client-id")).toBe("app_test");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
  });

  it("forwards a POST body and sets duplex for streaming", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 201 }));

    const req = new Request("http://web.local/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-id": "app_test" },
      body: JSON.stringify({ email: "a@b.c", password: "x" }),
    });

    const res = await proxyToUpstream(req, "https://auth.example");

    expect(res.status).toBe(201);
    const [target, init] = fetchMock.mock.calls[0] as [URL, RequestInit & { duplex?: string }];
    expect(target.toString()).toBe("https://auth.example/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.body).toBeDefined();
    expect(init.duplex).toBe("half");
  });

  it("returns 502 JSON when the upstream is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const req = new Request("http://web.local/api/health", { method: "GET" });
    const res = await proxyToUpstream(req, "https://down.example");

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ detail: "upstream_unreachable" });
  });

  it("strips Content-Encoding/Content-Length from the response (fetch already decoded the body)", async () => {
    // Node fetch hands back a decoded body but keeps the upstream's
    // Content-Encoding + (now-wrong) Content-Length headers. Forwarding those
    // would make the browser fail with ERR_CONTENT_DECODING_FAILED.
    const upstream = new Response('{"decoded":true}', {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "999",
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);

    const req = new Request("http://web.local/api/users/me/profile", { method: "GET" });
    const res = await proxyToUpstream(req, "https://stride-app.example");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ decoded: true });
  });
});
