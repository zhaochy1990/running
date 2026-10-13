import assert from "node:assert/strict";
import test from "node:test";
import { createActivityFeelWriter } from "../src/coach/activityFeelWriter.js";

const goApi = { baseUrl: "http://go:8080", internalToken: "tok" };

function jsonResponse(status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify({ error: "x" }), { status });
}

test("activity feel writer PATCHes the Go user endpoint with the internal token", async () => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const writer = createActivityFeelWriter(goApi, async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return jsonResponse(204);
  });

  await writer.setActivityFeel("11111111-2222-3333-4444-555555555555", "act-1", 7.5);

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.url, "http://go:8080/api/11111111-2222-3333-4444-555555555555/activities/act-1");
  assert.equal(request.method, "PATCH");
  assert.equal(request.headers["x-internal-token"], "tok");
  assert.deepEqual(request.body, { feel: 7.5 });
});

test("activity feel writer fails loud on non-2xx so the coach cannot fake success", async () => {
  const writer = createActivityFeelWriter(goApi, async () => jsonResponse(404));
  await assert.rejects(() => writer.setActivityFeel("11111111-2222-3333-4444-555555555555", "missing", 7), /404/);
});
