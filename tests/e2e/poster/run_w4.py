#!/usr/bin/env python3
"""epic-601 wave 4 — P7 #949 final E2E round (real data, dual users).

Drives the real WeChat DevTools simulator (no mocks). Ran against master
a169ae83 on 2026-11-10 in two env configurations:
  A: user 赵超毅 (real account, real activities): full 生成→保存→分享 chain
     + aspect matrix IHDR + theme switching/persistence + mid-render race
     + long image + strength (no-track) + poster/map 503 degrade on the local
     stack (post-pin production equivalent; wave 3 covered PROD 404 degrade).
  B: user E2E测试跑者 (second real identity): login isolation, empty list,
     cross-user access denial, cross-user state-leak regression (re-A render).
Usage: run_w4.py <step-name>   (each step appends into results.json)
Env: E2E_MP_PROJECT (mp path), E2E_W4_DIR (evidence/output dir, default
alongside this script; fn/ templates ship with the repo).
"""
import base64
import json
import os
import struct
import subprocess
import sys
import time

PROJECT = os.environ.get("E2E_MP_PROJECT", "/Users/zhaochaoyi/workspace/stride/running/src/wechat-miniprogram")
_HERE = os.path.dirname(os.path.abspath(__file__))
W4 = os.environ.get("E2E_W4_DIR", _HERE)
FN = f"{_HERE}/fn"
RESULTS = f"{W4}/results.json"

ACT_34K = "481577102567571657"        # 赵超毅 [STRIDE] 3km快+2km慢×7（35km）— GPS
ACT_STRENGTH = "481602133905408000"   # 赵超毅 力量训练 — no GPS
USER_A = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
USER_B = "42744d53-8bea-4c91-8db5-ee61d32aaa49"


def evaluate(fn, timeout=180):
    out = subprocess.run(
        ["wechatide", "-c", "ZCode", "automation_evaluate", "--project", PROJECT, "--fn-source", fn],
        capture_output=True, text=True, timeout=timeout,
    ).stdout
    start = out.find("{")
    if start < 0:
        raise RuntimeError("no json in output: " + out[:800])
    d, _ = json.JSONDecoder().raw_decode(out[start:])
    if not d.get("ok"):
        raise RuntimeError("evaluate failed: " + json.dumps(d)[:900])
    r = d["result"].get("result")
    for _ in range(3):
        if isinstance(r, dict) and set(r.keys()) == {"result"}:
            r = r["result"]
        else:
            break
    return r


def fn(name, **subs):
    src = open(f"{FN}/{name}.fn").read()
    for k, v in subs.items():
        src = src.replace(f"__{k}__", str(v))
    # node-validate as expression before shipping to the simulator
    subprocess.run(["node", "-e", f"new Function('return ('+{json.dumps(' '.join(src.split()))}+')');"],
                   check=True, capture_output=True)
    return src


def record(step, status, detail):
    results = json.load(open(RESULTS)) if os.path.exists(RESULTS) else {}
    results[step] = {"status": status, "at": time.strftime("%H:%M:%S"), "detail": detail}
    json.dump(results, open(RESULTS, "w"), indent=1, ensure_ascii=False)
    print(f"[{step}] {status}: {json.dumps(detail, ensure_ascii=False)[:400]}")


def run(step):
    getattr(sys.modules[__name__], "step_" + step)()


def _goto_detail(label_id, wait_s=8000):
    return evaluate(fn("goto-detail", LABEL=label_id, WAIT=wait_s))


def _wait_poster(timeout_s=40):
    """Poll sheet state from the host side (each evaluate is short-lived)."""
    t0 = time.time()
    last = {}
    while time.time() - t0 < timeout_s:
        last = evaluate(fn("sheet-state"))
        if last.get("path") == "set":
            evaluate("function(){ const ps=getCurrentPages(); const p=ps[ps.length-1];"
                     "const app=getApp(); app.__e2e=app.__e2e||{}; app.__e2e.lastPath=p.data.posterPreviewPath; return 1; }")
            return {**last, "waited": round(time.time() - t0, 1)}
        time.sleep(2)
    return {**last, "waited": round(time.time() - t0, 1), "timeout": True}


def _fetch_last_png(name):
    path = evaluate("function(){ return getApp().__e2e && getApp().__e2e.lastPath; }")
    if not isinstance(path, str) or not path:
        raise RuntimeError("no lastPath")
    total = evaluate(
        "function(){ return new Promise((res)=>{ wx.getFileSystemManager().readFile({"
        "filePath: " + json.dumps(path) + ", encoding: 'base64',"
        "success:(r)=>{ const app=getApp(); app.__e2e=app.__e2e||{}; app.__e2e.b64=r.data; res(r.data.length); },"
        "fail:(e)=>res('err:'+e.errMsg) }); }); }")
    if not isinstance(total, int):
        raise RuntimeError("read failed: %s" % total)
    parts, pos = [], 0
    while pos < total:
        want = min(40960, total - pos)
        part = evaluate("function(){ const b=getApp().__e2e.b64; return b.substr(%d,%d)+'|%d|'; }" % (pos, want, total))
        if not isinstance(part, str) or not part.endswith("|%d|" % total):
            raise RuntimeError("slice failed at %d" % pos)
        parts.append(part[: -(len(str(total)) + 2)])
        pos += want
    b = base64.b64decode("".join(parts))
    open(f"{W4}/{name}.png", "wb").write(b)
    w, h = struct.unpack(">II", b[16:24])
    return {"file": f"{name}.png", "bytes": len(b), "w": w, "h": h, "tempPath": path}


def _inject_session(which):
    sess = json.load(open(f"{W4}/session-{which}.json"))
    uid, name = (USER_A, "赵超毅") if which == "a" else (USER_B, "E2E测试跑者")
    js = ("function(){ const app=getApp(); app.__e2e=app.__e2e||{};"
          "wx.setStorageSync('access_token', %s); wx.setStorageSync('refresh_token', %s);"
          "wx.setStorageSync('token_expires_at', %d); wx.setStorageSync('user_info', { id: %s, name: %s });"
          "return { token24: (wx.getStorageSync('access_token')||'').slice(0,24) }; }"
          % (json.dumps(sess["access_token"]), json.dumps(sess.get("refresh_token")),
             int(sess["token_expires_at"]), json.dumps(uid), json.dumps(name)))
    return evaluate(js)


# ---------------------------------------------------------------- steps ---

def step_a1_inject_a():
    r = _inject_session("a")
    evaluate("function(){ wx.removeStorageSync('poster.theme'); return 'theme-cleared'; }")
    record("a1_inject_a", "done", r)


def step_a2_detail_34k():
    evaluate("function(){ return new Promise((res)=>{ wx.reLaunch({ url:'/pages/activities/activities', complete:()=>setTimeout(()=>res('at-activities'),2500) }); }); }")
    time.sleep(3)
    r = _goto_detail(ACT_34K)
    record("a2_detail_34k", "done" if r.get("name") and not r.get("notFound") else "fail", r)


def step_a3_open_sheet():
    r = evaluate(fn("open-sheet"))
    record("a3_open_sheet", "done" if r.get("sheet") else "fail", r)


def step_a4_aspect_matrix():
    out = {}
    for aspect, expect in (("3:4", (1080, 1440)), ("9:16", (1080, 1920)), ("4:5", (1080, 1350)), ("1:1", (1080, 1080))):
        evaluate(fn("tap-aspect", ASPECT=aspect))
        time.sleep(1)
        w = _wait_poster()
        png = _fetch_last_png("a4-34k-" + aspect.replace(":", "x"))
        ok = (png["w"], png["h"]) == expect
        out[aspect] = {"ihdr": [png["w"], png["h"]], "expect": list(expect), "ok": ok, "waited": w.get("waited")}
        if not ok:
            break
    record("a4_aspect_matrix", "done" if all(v["ok"] for v in out.values()) else "fail", out)


def step_a5_theme_switch():
    out = {}
    for t in ("midnight", "sakura", "lavender", "sunrise"):
        evaluate(fn("tap-theme", KEY=t))
        time.sleep(1)
        w = _wait_poster()
        st = evaluate(fn("sheet-state"))
        png = _fetch_last_png("a5-34k-" + t)
        out[t] = {"state": {k: st.get(k) for k in ("theme", "label", "storage", "path")},
                  "ihdr": [png["w"], png["h"]], "waited": w.get("waited")}
    evaluate(fn("close-sheet"))
    time.sleep(1)
    evaluate("function(){ const ps=getCurrentPages(); const p=ps[ps.length-1]; p.onSharePoster(); return 'reopened'; }")
    time.sleep(9)
    st = evaluate(fn("sheet-state"))
    out["reopen_persisted"] = {"expect_theme": "sunrise", "state": {k: st.get(k) for k in ("theme", "storage", "sheet")}}
    ok = all(v["state"]["theme"] == t and v["state"]["storage"] == t for t, v in out.items() if t in
             ("midnight", "sakura", "lavender", "sunrise")) and st.get("theme") == "sunrise"
    record("a5_theme_switch", "done" if ok else "fail", out)


def step_a6_race():
    evaluate(fn("a6-race"))
    time.sleep(15)
    st = evaluate(fn("race-state"))
    record("a6_race", "done" if st.get("theme") == "midnight" and st.get("pathsN", 0) >= 1 else "fail", st)


def step_a7_long_image():
    evaluate(fn("long-tap"))
    w = _wait_poster(60)
    png = _fetch_last_png("a7-34k-long")
    record("a7_long_image", "done" if png["w"] == 1080 and png["h"] > 3000 else "fail",
           {"ihdr": [png["w"], png["h"]], "pathsN": w.get("pathsN"), "waited": w.get("waited")})


def step_a8_strength():
    _goto_detail(ACT_STRENGTH)
    time.sleep(1)
    evaluate("function(){ const ps=getCurrentPages(); const p=ps[ps.length-1]; p.onSharePoster(); return 'opened'; }")
    time.sleep(9)
    w = _wait_poster()
    png = _fetch_last_png("a8-strength-34")
    record("a8_strength", "done" if png["w"] == 1080 and png["h"] == 1440 else "fail",
           {"ihdr": [png["w"], png["h"]], "waited": w.get("waited")})


def step_a9_save():
    evaluate(fn("instrument-io"))
    time.sleep(1)
    evaluate(fn("save-tap"))
    time.sleep(8)
    r = evaluate(fn("io-state"))
    ok = bool(r and r.get("save") and r["save"].get("filePath"))
    record("a9_save", "done" if ok else "fail", r)


def step_a10_preview():
    before = evaluate(fn("io-state"))
    evaluate(fn("preview-tap"))
    time.sleep(6)
    r = evaluate(fn("io-state"))
    ok = bool(r and r.get("preview") and r["preview"].get("urls"))
    record("a10_preview", "done" if ok else "fail", {"before_preview": before.get("preview"), "after": r.get("preview")})


def step_b1_inject_b():
    r = _inject_session("b")
    record("b1_inject_b", "done", r)


def step_b2_list_empty():
    r = evaluate(fn("relaunch-activities"))
    ok = r.get("top") == "pages/activities/activities" and r.get("loadedCount") == 0
    record("b2_list_empty", "done" if ok else "fail", r)


def step_b3_cross_access():
    r = _goto_detail(ACT_34K)
    ok = bool(r.get("notFound"))
    record("b3_cross_access", "done" if ok else "fail", r)


def step_b4_theme_scoped():
    r = evaluate("function(){ return { posterTheme: wx.getStorageSync('poster.theme')||'' }; }")
    record("b4_theme_scoped", "done", r)


def step_b5_back_to_a():
    _inject_session("a")
    r = _goto_detail(ACT_34K)
    evaluate("function(){ const ps=getCurrentPages(); const p=ps[ps.length-1]; p.onSharePoster(); return 'opened'; }")
    time.sleep(9)
    _wait_poster()
    st = evaluate(fn("sheet-state"))
    ok = bool(st.get("path") == "set" and st.get("theme") == st.get("storage") and st.get("name"))
    record("b5_back_to_a", "done" if ok else "fail", st)


if __name__ == "__main__":
    run(sys.argv[1])
