#!/bin/sh
# Renders the app icon nsh.json names (assets/icon.png, 1024x1024) from the
# two sources beside this script: the macOS-grid plate (an 824px plate on a
# 1024px canvas, so the Dock shows it the size of its neighbours) and the
# Omamail logo as a 596px layer centred on it. `nsh package` makes each
# platform's icon (ICNS, ICO, PNG) from that one file. Needs rsvg-convert
# (librsvg draws the rounded strokes; ImageMagick's own SVG reader facets
# them) and ImageMagick.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for tool in rsvg-convert magick; do
  command -v "$tool" >/dev/null 2>&1 || { printf '%s is required\n' "$tool" >&2; exit 1; }
done
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-icon-XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
rsvg-convert -w 1024 -h 1024 "$here/plate.svg" -o "$work/plate.png"
rsvg-convert -w 596 -h 596 "$here/logo.svg" -o "$work/logo.png"
magick "$work/plate.png" "$work/logo.png" -gravity center -composite -strip "$here/../icon.png"
