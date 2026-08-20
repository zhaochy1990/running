import type { BffConfig } from "../config.js";
import type { Upstream } from "./table.js";

/**
 * Map a resolved upstream to its base URL from config. Routing to `go` while
 * `GO_API_URL` is unset is a misconfiguration — surfaced as a thrown error the
 * request handler turns into a 502 rather than silently falling back to Python
 * (which would mask a broken cutover).
 */
export function baseUrlFor(upstream: Upstream, config: BffConfig): string {
  switch (upstream) {
    case "auth":
      return config.authUpstreamUrl;
    case "go":
      if (!config.goApiUrl) {
        throw new Error("request routed to Go upstream but GO_API_URL is not set");
      }
      return config.goApiUrl;
    case "python":
      return config.pythonApiUrl;
  }
}
