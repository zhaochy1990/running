import { createServer } from "node:http";
import { createApp } from "./app.js";

const app = createApp({
	jwtVerifier: {
		async verify() {
			return { userId: "smoke-user" };
		},
	},
	coach: {
		async invoke() {
			return { messages: [{ type: "ai", content: "SMOKE_OK" }] };
		},
	},
});
const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	const result = await app.request(url.pathname, {
		method: request.method ?? "GET",
	});
	response.writeHead(result.status, Object.fromEntries(result.headers));
	response.end(Buffer.from(await result.arrayBuffer()));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no address");
	const response = await fetch(`http://127.0.0.1:${address.port}/health`);
	if (!response.ok || (await response.text()) !== '{"status":"ok"}') {
		throw new Error("health smoke failed");
	}
	process.stdout.write("COACH_AGENT_API_SMOKE_OK\n");
} finally {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}
