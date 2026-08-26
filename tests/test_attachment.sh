#!/bin/sh
# What attachment.sh reads off disk and off the clipboard.
#
# The QML side never opens a file itself: it asks this script, and this script
# answers with one JSON object. The tests stub `wl-paste` and `file` so they
# do not need a compositor or a particular magic database.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/attachment.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-attach-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP

failures=0

ok() { printf '  ok   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  failures=$((failures + 1))
}

check() {
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '         expected: %s\n' "$3"
    printf '         actual:   %s\n' "$2"
  fi
}

contains() {
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else
    bad "$1"
    printf '         looked for: %s\n' "$3"
  fi
}

missing() {
  if printf '%s' "$2" | grep -qF -- "$3"; then
    bad "$1"
    printf '         did not expect: %s\n' "$3"
  else
    ok "$1"
  fi
}

json_field() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1" <<EOF
$2
EOF
}

printf 'attachment.sh\n'

mkdir -p "$work/bin" "$work/compose"
cat > "$work/bin/file" <<'STUB'
#!/bin/sh
# GNU file's --mime-type answer, without consulting a real magic database.
path=$1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; path=$1; break ;;
    -*) shift ;;
    *) path=$1; shift ;;
  esac
done
case "$path" in
  *.png) printf 'image/png\n' ;;
  *.pdf) printf 'application/pdf\n' ;;
  *) printf 'application/octet-stream\n' ;;
esac
STUB
chmod +x "$work/bin/file"

PATH="$work/bin:$PATH"
export PATH

printf 'hello table\n' > "$work/notes.txt"
answer=$(sh "$script" read "$work/notes.txt")
check "read says ok" "$(json_field ok "$answer")" "True"
check "read keeps the filename" "$(json_field filename "$answer")" "notes.txt"
check "read keeps the path" "$(json_field path "$answer")" "$work/notes.txt"
check "read counts octets" "$(json_field size "$answer")" "12"
data=$(json_field data "$answer")
decoded=$(printf '%s' "$data" | base64 -d)
check "read data round-trips" "$decoded" "$(printf 'hello table\n')"

printf '\x89PNG\r\n' > "$work/shot.png"
answer=$(sh "$script" read "$work/shot.png")
check "png is image/png" "$(json_field mimeType "$answer")" "image/png"

printf '%%PDF-1.4\n' > "$work/invoice.pdf"
answer=$(sh "$script" read "$work/invoice.pdf")
check "pdf is application/pdf" "$(json_field mimeType "$answer")" "application/pdf"
check "pdf keeps the filename" "$(json_field filename "$answer")" "invoice.pdf"
pdf_data=$(json_field data "$answer")
check "pdf data round-trips" "$(printf '%s' "$pdf_data" | base64 -d)" "$(printf '%%PDF-1.4\n')"

answer=$(sh "$script" read "$work/missing.bin" || true)
check "missing file is not ok" "$(json_field ok "$answer")" "False"

# A quote in a name must not break the JSON object.
printf 'x' > "$work/say\"hi.txt"
answer=$(sh "$script" read "$work/say\"hi.txt")
python3 -c 'import json,sys; json.load(sys.stdin)' <<EOF
$answer
EOF
check "quoted filename is still JSON" "$?" "0"
check "quoted filename survives" "$(json_field filename "$answer")" 'say"hi.txt'

# Over the 20 MiB ceiling. Sparse so the test does not write 20 MB.
dd if=/dev/zero of="$work/huge.bin" bs=1 count=1 seek=$((20 * 1024 * 1024)) status=none 2>/dev/null \
  || dd if=/dev/zero of="$work/huge.bin" bs=1 count=1 seek=$((20 * 1024 * 1024)) 2>/dev/null
answer=$(sh "$script" read "$work/huge.bin" || true)
check "oversize is refused" "$(json_field ok "$answer")" "False"
contains "oversize names the limit" "$answer" "20 MB"

# Clipboard: a stub that claims a PNG and writes six bytes.
cat > "$work/bin/wl-paste" <<'STUB'
#!/bin/sh
if [ "$1" = "--list-types" ]; then
  printf 'image/png\ntext/plain\n'
  exit 0
fi
if [ "$1" = "--type" ] && [ "$2" = "image/png" ]; then
  printf 'PNGIMG'
  exit 0
fi
exit 1
STUB
chmod +x "$work/bin/wl-paste"

answer=$(sh "$script" clipboard "$work/compose")
check "clipboard image is ok" "$(json_field ok "$answer")" "True"
check "clipboard image is a png" "$(json_field mimeType "$answer")" "image/png"
clip_path=$(json_field path "$answer")
case "$clip_path" in
  "$work/compose"/screenshot-*.png) ok "clipboard writes into the compose dir" ;;
  *) bad "clipboard writes into the compose dir"; printf '         path: %s\n' "$clip_path" ;;
esac
check "clipboard data is the stub bytes" "$(json_field data "$answer" | base64 -d)" "PNGIMG"
check "clipboard file is owned on disk" "$(cat "$clip_path")" "PNGIMG"

cat > "$work/bin/wl-paste" <<'STUB'
#!/bin/sh
if [ "$1" = "--list-types" ]; then
  printf 'text/plain\n'
  exit 0
fi
exit 1
STUB
chmod +x "$work/bin/wl-paste"
answer=$(sh "$script" clipboard "$work/compose")
check "text clipboard is no-image" "$(json_field ok "$answer")" "False"
check "text clipboard names no-image" "$(json_field error "$answer")" "no-image"

# Files copied in Omafiles are text/uri-list. Pasting those into a draft
# should attach the files, not fail as "no image".
cat > "$work/bin/wl-paste" <<'STUB'
#!/bin/sh
if [ "$1" = "--list-types" ]; then
  printf 'text/uri-list\ntext/plain\n'
  exit 0
fi
if [ "$1" = "--type" ] && [ "$2" = "text/uri-list" ]; then
  printf 'file:///tmp/table.png\r\nfile:///home/elias/My%%20shot.pdf\r\n'
  exit 0
fi
exit 1
STUB
chmod +x "$work/bin/wl-paste"
answer=$(sh "$script" clipboard "$work/compose")
check "uri-list clipboard is ok" "$(json_field ok "$answer")" "True"
uris=$(printf '%s' "$answer" | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["paths"]))')
check "uri-list clipboard decodes paths" "$uris" "$(printf '%s\n' /tmp/table.png "/home/elias/My shot.pdf")"

# A PDF copied as bytes, the way some viewers put application/pdf on the
# clipboard instead of a file:// URI.
cat > "$work/bin/wl-paste" <<'STUB'
#!/bin/sh
if [ "$1" = "--list-types" ]; then
  printf 'application/pdf\ntext/plain\n'
  exit 0
fi
if [ "$1" = "--type" ] && [ "$2" = "application/pdf" ]; then
  printf '%%PDF-1.4\nclipboard-pdf\n'
  exit 0
fi
exit 1
STUB
chmod +x "$work/bin/wl-paste"
answer=$(sh "$script" clipboard "$work/compose")
check "clipboard pdf is ok" "$(json_field ok "$answer")" "True"
check "clipboard pdf is application/pdf" "$(json_field mimeType "$answer")" "application/pdf"
clip_pdf=$(json_field path "$answer")
case "$clip_pdf" in
  "$work/compose"/paste-*.pdf) ok "clipboard pdf writes a paste file" ;;
  *) bad "clipboard pdf writes a paste file"; printf '         path: %s\n' "$clip_pdf" ;;
esac
check "clipboard pdf data is the stub bytes" \
  "$(json_field data "$answer" | base64 -d)" "$(printf '%%PDF-1.4\nclipboard-pdf\n')"

# A chooser in its own process, not Qt's in-process FileDialog.
cat > "$work/bin/omarchy-file-select" <<'STUB'
#!/bin/sh
printf '%s\n' "$OMAMAIL_PICK_OUT"
exit "${OMAMAIL_PICK_EXIT:-0}"
STUB
chmod +x "$work/bin/omarchy-file-select"
OMAMAIL_PICK_OUT=$(printf '%s\n' one.png two.pdf)
export OMAMAIL_PICK_OUT
answer=$(sh "$script" pick)
check "pick says ok" "$(json_field ok "$answer")" "True"
picked=$(printf '%s' "$answer" | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["paths"]))')
check "pick returns both paths" "$picked" "$(printf '%s\n' one.png two.pdf)"
OMAMAIL_PICK_EXIT=1
OMAMAIL_PICK_OUT=
export OMAMAIL_PICK_EXIT OMAMAIL_PICK_OUT
answer=$(sh "$script" pick)
check "a cancelled picker is cancelled, not an error" "$(json_field error "$answer")" "cancelled"
unset OMAMAIL_PICK_OUT OMAMAIL_PICK_EXIT

# forget only deletes files this script wrote into the compose dir.
printf 'keep\n' > "$work/outside.txt"
sh "$script" forget "$work/compose" "$work/outside.txt" >/dev/null 2>&1 || true
check "forget refuses a file outside the compose dir" "$(cat "$work/outside.txt")" "keep"
sh "$script" forget "$work/compose" "$clip_path" >/dev/null
if [ -e "$clip_path" ]; then
  bad "forget removes a file it wrote"
else
  ok "forget removes a file it wrote"
fi

if [ "$failures" -ne 0 ]; then
  printf 'test_attachment.sh: %s failed\n' "$failures" >&2
  exit 1
fi
printf 'test_attachment.sh ok\n'
