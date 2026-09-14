#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
source_logo="$root/resources/icons/omamail.svg"
plate="$root/resources/macos/omamail-macos.svg"
mac_icon="$root/resources/macos/omamail.icns"
windows_icon="$root/resources/windows/omamail.ico"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-native-icons-XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM

command -v magick >/dev/null 2>&1 || { printf 'ImageMagick is required\n' >&2; exit 1; }
command -v iconutil >/dev/null 2>&1 || { printf 'Apple iconutil is required\n' >&2; exit 1; }

magick -background none "$plate" -resize 1024x1024 "$work/plate.png"
magick -background none -density 768 "$source_logo" -resize 596x596 "$work/logo.png"
magick "$work/plate.png" "$work/logo.png" -gravity center -composite "$work/master.png"

iconset="$work/omamail.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  magick "$work/master.png" -resize "${size}x${size}" "$iconset/icon_${size}x${size}.png"
  double=$((size * 2))
  magick "$work/master.png" -resize "${double}x${double}" "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o "$mac_icon"
magick "$work/master.png" -define icon:auto-resize=256,128,64,48,32,16 "$windows_icon"
