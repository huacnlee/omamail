#!/usr/bin/env python3
"""Regenerate synchronous UI facts from the compiled native provider domain."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
binary = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "target/debug/omamail"
reply = json.loads(subprocess.check_output([str(binary), "--json", "call", "providers.snapshot"], input=b"{}"))
if not reply.get("ok"):
    raise SystemExit("Native provider snapshot failed")
(root / "ui/providers/NativeDomain.js").write_text(
    ".pragma library\n\n// Generated from Rust providers::domain::snapshot; parity is verified by Rust tests.\nvar FACTS = "
    + json.dumps(reply["result"], indent=2, ensure_ascii=False) + "\n"
)
