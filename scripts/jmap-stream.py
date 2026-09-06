#!/usr/bin/env python3
"""Run curl and frame bounded SSE events before the desktop receives them.

The curl config (including credentials) is inherited on stdin, never argv.
Normalize CR, LF and CRLF incrementally; only complete, bounded events reach
Quickshell's SplitParser. Its own buffer therefore cannot grow with an
unterminated server event. Curl's final HTTP trailer is retained at EOF.
"""
import os
import signal
import subprocess
import sys

MAX_EVENT_BYTES = 65536


class EventTooLarge(Exception):
    pass


def forward(source, destination):
    event = bytearray()
    previous_cr = False
    line_empty = True
    while True:
        chunk = os.read(source.fileno(), 4096)
        if not chunk:
            break
        for byte in chunk:
            if previous_cr and byte == 10:
                previous_cr = False
                continue
            previous_cr = byte == 13
            if len(event) >= MAX_EVENT_BYTES:
                raise EventTooLarge
            if byte in (10, 13):
                event.append(10)
                if line_empty:
                    # Empty segments are not consumed by SplitParser. Never
                    # send blank-only events that could accumulate in it.
                    if len(event) > 1:
                        destination.write(event)
                        destination.flush()
                    event.clear()
                line_empty = True
            else:
                event.append(byte)
                line_empty = False
    if event:
        # curl's write-out trailer has one newline, not an SSE blank line.
        destination.write(event)
        destination.flush()


def main():
    child = None
    interrupted = 0

    def stop(signum, _frame):
        nonlocal interrupted
        # Popen may be between fork and returning the child object. Record
        # cancellation until ownership is established, then reap in finally.
        interrupted = 128 + signum
        if child is not None:
            raise SystemExit(interrupted)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, stop)
    try:
        child = subprocess.Popen(["curl", "-q", "--globoff", "--config", "-"],
                                 stdin=sys.stdin.buffer, stdout=subprocess.PIPE)
        if interrupted:
            return interrupted
        forward(child.stdout, sys.stdout.buffer)
        return child.wait()
    except EventTooLarge:
        return 63
    except BrokenPipeError:
        return 23
    finally:
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, signal.SIG_IGN)
        # A refusal and an owner cancellation both close the authenticated
        # connection, even if curl is waiting for a server that never replies.
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        if child is not None:
            child.stdout.close()


if __name__ == "__main__":
    sys.exit(main())
