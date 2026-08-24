#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/open-attachment.py"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-attachment-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP

mkdir -p "$work/bin" "$work/runtime"

cat > "$work/bin/xdg-open" <<'STUB'
#!/bin/sh
printf '%s\n' "$1" > "$OPEN_CAPTURE"
STUB
chmod +x "$work/bin/xdg-open"

printf '\000\001\177\200\376\377attachment bytes\n' > "$work/expected"
filename=$(printf '%s' '../../Quarterly report.pdf' | base64 | tr -d '\n')
body=$(base64 < "$work/expected" | tr -d '\n=' | tr '/+' '_-')

printf '%s\n%s\n' "$filename" "$body" \
  | XDG_RUNTIME_DIR="$work/runtime" OPEN_CAPTURE="$work/opened" \
    PATH="$work/bin:$PATH" "$script"

tries=0
while [ ! -s "$work/opened" ] && [ "$tries" -lt 100 ]; do
  sleep 0.01
  tries=$((tries + 1))
done

[ -s "$work/opened" ] || { echo "test_attachment_open.sh: xdg-open was not called" >&2; exit 1; }
opened=$(sed -n '1p' "$work/opened")

[ "$(basename "$opened")" = "Quarterly report.pdf" ] \
  || { echo "test_attachment_open.sh: unsafe filename was not reduced to its basename" >&2; exit 1; }
case "$opened" in
  "$work/runtime"/omamail-attachment-*/Quarterly\ report.pdf) ;;
  *) echo "test_attachment_open.sh: attachment escaped its private runtime directory: $opened" >&2; exit 1 ;;
esac

cmp "$work/expected" "$opened" \
  || { echo "test_attachment_open.sh: attachment bytes changed" >&2; exit 1; }
[ "$(stat -c '%a' "$opened")" = "600" ] \
  || { echo "test_attachment_open.sh: attachment is not private" >&2; exit 1; }
[ "$(stat -c '%a' "$(dirname "$opened")")" = "700" ] \
  || { echo "test_attachment_open.sh: attachment directory is not private" >&2; exit 1; }

rm -f "$work/opened"
if printf '%s\n%s\n' "$filename" 'not*base64' \
  | XDG_RUNTIME_DIR="$work/runtime" OPEN_CAPTURE="$work/opened" \
    PATH="$work/bin:$PATH" "$script" >/dev/null 2>&1; then
  echo "test_attachment_open.sh: malformed attachment data was accepted" >&2
  exit 1
fi
[ ! -e "$work/opened" ] \
  || { echo "test_attachment_open.sh: malformed attachment data reached xdg-open" >&2; exit 1; }

printf 'test_attachment_open.sh ok\n'
