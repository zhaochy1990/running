#!/usr/bin/env python3
"""epic-601 wave 4 (P7 #949 final round) — evaluate JS in the miniprogram appService.

Reuse of the wave-3 harness (no mocks: drives the real WeChat DevTools simulator
via wechatide automation against the real app at master a169ae83, PROD env as
shipped). Usage: eval.py <fn-file>  -> prints JSON result.
"""
import json
import subprocess
import sys

PROJECT = __import__("os").environ.get("E2E_MP_PROJECT", "/Users/zhaochaoyi/workspace/stride/running/src/wechat-miniprogram")


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
        raise RuntimeError("evaluate failed: " + json.dumps(d)[:800])
    r = d["result"].get("result")
    for _ in range(3):
        if isinstance(r, dict) and set(r.keys()) == {"result"}:
            r = r["result"]
        else:
            break
    return r


if __name__ == "__main__":
    fn = open(sys.argv[1]).read()
    print(json.dumps(evaluate(fn), ensure_ascii=False, indent=1))
