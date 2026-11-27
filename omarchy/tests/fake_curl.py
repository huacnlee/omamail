#!/usr/bin/env python3
"""A stand-in for curl, as install.sh calls it, serving a local release tree.

$FIXTURES/v<version>/<asset> answers .../releases/download/v<version>/<asset>,
and .../releases/latest redirects to v$MOCK_LATEST. Every URL asked for is
appended to $CURL_LOG when it is set. Used by test_install.py and by
release.yml to install the archives it has just built.
"""
import os
import pathlib
import shutil
import sys

args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith("https://"))
if os.environ.get("CURL_LOG"):
    with open(os.environ["CURL_LOG"], "a") as log:
        log.write(url + "\n")
if url.endswith("/releases/latest"):
    print("https://github.com/huacnlee/omamail/releases/tag/v" + os.environ["MOCK_LATEST"], end="")
    sys.exit(0)
version, name = url.split("/releases/download/", 1)[1].split("/", 1)
source = pathlib.Path(os.environ["FIXTURES"]) / version / name
if not source.is_file():
    print(f"curl: (22) The requested URL returned error: 404 ({url})", file=sys.stderr)
    sys.exit(22)
shutil.copyfile(source, args[args.index("--output") + 1])
