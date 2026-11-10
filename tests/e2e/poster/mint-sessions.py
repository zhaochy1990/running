#!/usr/bin/env python3
"""Wave 4 — mint REAL sessions for the two E2E users via the local auth-backend
(same remote auth DB prod uses; every token comes from the real auth service).
Secrets via env (see README); nothing sensitive is committed.

  User A = f10bc353 (赵超毅, real account, real activities incl. GPS runs)
  User B = 42744d53 (E2E 测试用户, seeded real test identity, no activities)

User A reuses the wave-3 rotated password directly (no fresh reset); falls back
to the admin reset-password path if the rotated password was changed.
Usage: mint-sessions.py -> writes session-a.json + session-b.json
"""
import json
import os
import sys
import time
import urllib.request

AUTH = os.environ.get("E2E_AUTH_BASE", "http://localhost:3001")
MP_CLIENT = "app_895073719c0147368b8feed3"
OUT_DIR = os.environ.get("E2E_W4_DIR", os.path.dirname(os.path.abspath(__file__)))

# Real identities; secrets come from the environment, never from git:
#   E2E_USER_A_EMAIL / E2E_USER_A_PASSWORD  (activity owner, real account)
#   E2E_USER_B_EMAIL / E2E_USER_B_PASSWORD  (seeded test identity)
USER_A = {"id": os.environ.get("E2E_USER_A_ID", "f10bc353-01ab-4db1-af9f-d9305ea9a532"),
          "email": os.environ.get("E2E_USER_A_EMAIL", ""),
          "pw": os.environ.get("E2E_USER_A_PASSWORD", "")}
USER_B = {"id": os.environ.get("E2E_USER_B_ID", "42744d53-8bea-4c91-8db5-ee61d32aaa49"),
          "email": os.environ.get("E2E_USER_B_EMAIL", "e2e@example.com"),
          "pw": os.environ.get("E2E_USER_B_PASSWORD", "")}


def post(path, body, headers=None):
    req = urllib.request.Request(
        AUTH + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def login(email, pw):
    st, sess = post("/api/auth/login", {"email": email, "password": pw},
                    {"X-Client-Id": MP_CLIENT})
    return st, sess


def main():
    env = {}
    for line in open(os.environ.get("E2E_TEST_ENV", "/Users/zhaochaoyi/workspace/stride/stride-devops/test/.env")):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v

    # --- user A: password from env; if rejected, admin reset-password to the
    # same value (requires the provisioning admin creds in test/.env) ---
    if not USER_A["email"] or not USER_A["pw"]:
        print("set E2E_USER_A_EMAIL / E2E_USER_A_PASSWORD"); sys.exit(1)
    st, sess = login(USER_A["email"], USER_A["pw"])
    if st != 200:
        print("A direct login %d — resetting via admin" % st)
        st2, admin = post("/api/auth/login",
                          {"email": env["ADMIN_EMAIL"], "password": env["ADMIN_PASSWORD"]},
                          {"X-Client-Id": env["AUTH_CLIENT_ID"]})
        if st2 != 200 or "access_token" not in admin:
            print("admin login failed:", st2, admin); sys.exit(1)
        st3, res = post(f"/admin/users/{USER_A['id']}/reset-password",
                        {"password": USER_A["pw"], "revoke_sessions": False},
                        {"Authorization": "Bearer " + admin["access_token"]})
        print("reset-password:", st3, res)
        if st3 != 200:
            sys.exit(1)
        time.sleep(1)
        st, sess = login(USER_A["email"], USER_A["pw"])
    if st != 200 or "access_token" not in sess:
        print("user A login failed:", st, sess); sys.exit(1)
    out_a = {"access_token": sess["access_token"], "refresh_token": sess.get("refresh_token"),
             "expires_in": sess.get("expires_in"),
             "token_expires_at": int(time.time()) + int(sess.get("expires_in", 3600)),
             "client_id": MP_CLIENT, "user_id": USER_A["id"], "name": "赵超毅"}
    json.dump(out_a, open(f"{OUT_DIR}/session-a.json", "w"), indent=1)
    print("user A ok; sub-verified below")

    # --- user B: seeded credentials (password may live in test/.env), plain grant ---
    if not USER_B["pw"]:
        USER_B["pw"] = env.get("TEST_USER_PASSWORD", "")
    st, sess = login(USER_B["email"], USER_B["pw"])
    if st != 200 or "access_token" not in sess:
        print("user B login failed:", st, sess); sys.exit(1)
    out_b = dict(out_a)
    out_b.update({"access_token": sess["access_token"], "refresh_token": sess.get("refresh_token"),
                  "user_id": USER_B["id"], "name": "E2E测试用户"})
    json.dump(out_b, open(f"{OUT_DIR}/session-b.json", "w"), indent=1)
    print("user B ok")

    import base64
    for tag, path in (("A", f"{OUT_DIR}/session-a.json"), ("B", f"{OUT_DIR}/session-b.json")):
        tok = json.load(open(path))["access_token"].split(".")[1]
        tok += "=" * (-len(tok) % 4)
        claims = json.loads(base64.urlsafe_b64decode(tok))
        print("user", tag, claims.get("sub"), claims.get("name"), claims.get("aud"))


if __name__ == "__main__":
    main()
