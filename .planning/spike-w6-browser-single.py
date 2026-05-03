#!/usr/bin/env python3
"""Single-server variant of the W6 browser test. Runs run_test against one
port + session label, useful for A/B-ing the same server before and after
applying the fix."""

import argparse
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cm_ab", HERE / "spike-w6-browser-test.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=3457)
ap.add_argument("--session", type=int, default=0)
ap.add_argument("--label", default="run")
args = ap.parse_args()

result = mod.run_test(args.port, args.session, args.label)
print(f"\n=== verdict ===")
print(f"  {args.label}: before={result['before_seen']} after={result['after_seen']}")
sys.exit(0 if result["after_seen"] else 1)
