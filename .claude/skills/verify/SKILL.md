---
name: verify
summary: Verify STRIDE server changes through a local HTTP surface.
---

# STRIDE server verification

1. Start the production app locally with development auth enabled:

```bash
STRIDE_CONFIG_ENV=local python -m uvicorn stride_server.main:app --host 127.0.0.1 --port 8765
```

2. Wait for `GET http://127.0.0.1:8765/api/health` to return `{"status":"ok"}`.
3. Drive changed API/static routes with `curl`, including at least one adjacent error or malformed-input probe.
4. Stop the server after capturing response status, headers, and body evidence.

For frontend static assets, discover the current Vite hash under `frontend/dist/assets/`; do not assume a prior build's filename.
