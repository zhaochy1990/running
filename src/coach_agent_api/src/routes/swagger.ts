import { swaggerUI } from "@hono/swagger-ui";
import type { Env, Hono } from "hono";
import { OPENAPI_DOCUMENT } from "../openapi.js";

export function registerSwaggerRoutes<E extends Env>(app: Hono<E>): void {
  app.get("/openapi.json", (context) => context.json(OPENAPI_DOCUMENT));
  app.get(
    "/docs",
    swaggerUI({
      title: "Coach Agent API documentation",
      url: "/openapi.json",
      version: "5.32.14",
      persistAuthorization: false,
      manuallySwaggerUIHtml: (assets) => `
				<div>
					<div id="swagger-ui"></div>
					<link
						rel="stylesheet"
						href="${assets.css[0]}"
						integrity="sha384-fgyWYkUAamzuI8mJFu/xpRP0JWCJRwkwUwsYDoOYVHUJ8NQE5cENn8ib3ppwFFSX"
						crossorigin="anonymous"
					/>
					<script
						src="${assets.js[0]}"
						integrity="sha384-Dt83RhU85ZmX7werw9uTFCzmauXUoSyx3pdzTQMABtsnFmooJy4Vz9/ACh7n5m1A"
						crossorigin="anonymous"
					></script>
					<script>
						window.onload = () => {
							window.ui = SwaggerUIBundle({
								dom_id: "#swagger-ui",
								url: "/openapi.json",
								persistAuthorization: false,
							});
						};
					</script>
				</div>
			`,
    }),
  );
}
