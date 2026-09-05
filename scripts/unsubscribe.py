#!/usr/bin/env python3
"""One RFC 8058 POST; stdin retains the panel's three base64 fields."""
import http.client
import sys

from public_http import Refused, deadline, read_fields, unsubscribe


def main():
    try:
        with deadline():
            url, content_type, body = read_fields(sys.stdin.buffer, 3)
            if content_type != "application/x-www-form-urlencoded" or body != "List-Unsubscribe=One-Click":
                raise Refused("Invalid one-click request")
            status = unsubscribe(url)
        print("0", status)
        return 0
    except (ValueError, OSError, http.client.HTTPException):
        # Never echo a URL (it may carry a subscriber token) or raw server error.
        print("1 0")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
