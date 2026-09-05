#!/usr/bin/env python3
"""Return a bounded, public-host raster image as a data URI; never launch curl."""
import http.client
import sys

from public_http import deadline, fetch_image, read_fields


def main():
    try:
        with deadline():
            (url,) = read_fields(sys.stdin.buffer, 1)
            data = fetch_image(url)
        print(data)
        return 0
    except (ValueError, OSError, http.client.HTTPException):
        print("The remote image could not be loaded", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
