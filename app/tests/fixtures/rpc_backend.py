#!/usr/bin/env python3
import json
import os
import signal
import sys
import time


def main():
    mode = sys.argv[1]
    if mode == "probe":
        payload = sys.stdin.buffer.read()
        print(json.dumps({"argv": sys.argv[2:], "stdin": payload.hex()}), flush=True)
    elif mode == "utf8":
        payload = "first €\nsecond U0001f642\n".encode("utf-8")
        for byte in payload:
            os.write(sys.stdout.fileno(), bytes([byte]))
            time.sleep(0.002)
    elif mode == "stderr":
        os.write(sys.stderr.fileno(), b"x" * (256 * 1024))
    elif mode == "exit":
        sys.exit(int(sys.argv[2]))
    elif mode == "crash":
        os.abort()
    elif mode == "tree":
        child = os.fork()
        if child == 0:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            while True:
                time.sleep(1)
        print(child, flush=True)
        while True:
            time.sleep(1)
    elif mode == "serve":
        for raw in sys.stdin.buffer:
            request = json.loads(raw)
            if request["method"] == "system.info":
                result = {"name": "omamail", "version": "fixture-1",
                          "protocol": 1, "apiVersion": 9,
                          "methods": ["system.info", "system.quit"]}
            elif request["method"] == "system.quit":
                result = {"quitReady": True}
            else:
                raise SystemExit("unexpected method")
            print(json.dumps({"jsonrpc": "2.0", "id": request["id"],
                              "result": result}), flush=True)
            if request["method"] == "system.quit":
                return
    else:
        raise SystemExit("unknown fixture mode")


if __name__ == "__main__":
    main()
