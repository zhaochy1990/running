#!/usr/bin/env python3
"""Quick syntactic-balance check for Dart files when no Dart SDK is available.

Strips // line comments and /* */ block comments, then null-replaces the
*contents* of single- and double-quoted strings (preserving newlines so line
numbers in error messages line up). Counts (), {}, [] in what remains and
flags any imbalance.

Usage:  python3 scripts/dart_balance.py path/one.dart path/two.dart
Exit 0 if all files balance; 1 otherwise.
"""

import re
import sys


def _strip(src: str) -> str:
    s = re.sub(r"//[^\n]*", "", src)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)

    def collapse_string(match: "re.Match[str]") -> str:
        raw = match.group(0)
        nls = raw.count("\n")
        return raw[0] + ("\n" * nls) + raw[-1]

    s = re.sub(r"'(?:\\.|[^'\\])*'", collapse_string, s)
    s = re.sub(r'"(?:\\.|[^"\\])*"', collapse_string, s)
    return s


def check(path: str) -> bool:
    with open(path, "r", encoding="utf-8") as fp:
        stripped = _strip(fp.read())
    pairs = (("(", ")"), ("{", "}"), ("[", "]"))
    ok = all(stripped.count(a) == stripped.count(b) for a, b in pairs)
    diff = " ".join(
        f"{a}:{stripped.count(a)}/{b}:{stripped.count(b)}" for a, b in pairs
    )
    print(("OK   " if ok else "FAIL "), path, diff)
    return ok


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: dart_balance.py file.dart [file.dart ...]", file=sys.stderr)
        sys.exit(2)
    if all(check(p) for p in sys.argv[1:]):
        sys.exit(0)
    sys.exit(1)
