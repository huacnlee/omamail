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

rm -f "$work/opened"
mixed_name=$(printf '%s' 'invoice.HTML' | base64 | tr -d '\n')
if printf '%s\n%s\n' "$mixed_name" "$body" \
  | XDG_RUNTIME_DIR="$work/runtime" OPEN_CAPTURE="$work/opened" \
    PATH="$work/bin:$PATH" "$script" >/dev/null 2>&1; then
  echo "test_attachment_open.sh: a mixed-case HTML attachment was opened" >&2
  exit 1
fi
[ ! -e "$work/opened" ] \
  || { echo "test_attachment_open.sh: a mixed-case HTML attachment reached xdg-open" >&2; exit 1; }

rm -f "$work/opened"
wide_name=$(python3 -c 'import base64,sys; sys.stdout.write(base64.b64encode("invoice．html".encode()).decode())')
if printf '%s\n%s\n' "$wide_name" "$body" \
  | XDG_RUNTIME_DIR="$work/runtime" OPEN_CAPTURE="$work/opened" \
    PATH="$work/bin:$PATH" "$script" >/dev/null 2>&1; then
  echo "test_attachment_open.sh: a fullwidth-dot HTML attachment was opened" >&2
  exit 1
fi
[ ! -e "$work/opened" ] \
  || { echo "test_attachment_open.sh: a fullwidth-dot HTML attachment reached xdg-open" >&2; exit 1; }

rm -f "$work/opened"
dot_name=$(printf '%s' 'invoice.html.' | base64 | tr -d '\n')
if printf '%s\n%s\n' "$dot_name" "$body" \
  | XDG_RUNTIME_DIR="$work/runtime" OPEN_CAPTURE="$work/opened" \
    PATH="$work/bin:$PATH" "$script" >/dev/null 2>&1; then
  echo "test_attachment_open.sh: a trailing-dot HTML attachment was opened" >&2
  exit 1
fi
[ ! -e "$work/opened" ] \
  || { echo "test_attachment_open.sh: a trailing-dot HTML attachment reached xdg-open" >&2; exit 1; }

rm -f "$work/opened"
html_name=$(printf '%s' 'invoice.html' | base64 | tr -d '\n')
if printf '%s\n%s\n' "$html_name" "$body" \
  | XDG_RUNTIME_DIR="$work/runtime" OPEN_CAPTURE="$work/opened" \
    PATH="$work/bin:$PATH" "$script" >/dev/null 2>&1; then
  echo "test_attachment_open.sh: an HTML attachment was opened" >&2
  exit 1
fi
[ ! -e "$work/opened" ] \
  || { echo "test_attachment_open.sh: an HTML attachment reached xdg-open" >&2; exit 1; }

rm -f "$work/opened"
desktop_name=$(printf '%s' 'invoice.pdf.desktop' | base64 | tr -d '\n')
if printf '%s\n%s\n' "$desktop_name" "$body" \
  | XDG_RUNTIME_DIR="$work/runtime" OPEN_CAPTURE="$work/opened" \
    PATH="$work/bin:$PATH" "$script" >/dev/null 2>&1; then
  echo "test_attachment_open.sh: a desktop entry was opened" >&2
  exit 1
fi
[ ! -e "$work/opened" ] \
  || { echo "test_attachment_open.sh: a desktop entry reached xdg-open" >&2; exit 1; }

refuse_active_bytes() {
  label=$1
  sent_name=$2
  sent_body=$3
  rm -f "$work/opened"
  before=$(find "$work/runtime" -mindepth 1 | wc -l)
  encoded_name=$(printf '%s' "$sent_name" | base64 | tr -d '\n')
  encoded_body=$(printf '%s' "$sent_body" | base64 | tr -d '\n')
  if printf '%s\n%s\n' "$encoded_name" "$encoded_body" \
    | XDG_RUNTIME_DIR="$work/runtime" OPEN_CAPTURE="$work/opened" \
      PATH="$work/bin:$PATH" "$script" >/dev/null 2>&1; then
    echo "test_attachment_open.sh: $label was opened" >&2
    exit 1
  fi
  [ ! -e "$work/opened" ] \
    || { echo "test_attachment_open.sh: $label reached xdg-open" >&2; exit 1; }
  after=$(find "$work/runtime" -mindepth 1 | wc -l)
  [ "$after" -eq "$before" ] \
    || { echo "test_attachment_open.sh: $label was written before refusal" >&2; exit 1; }
}

refuse_active_bytes "HTML bytes disguised as PDF" "invoice.pdf" \
  '<!doctype html><script src="https://sender.example/run.js"></script>'
refuse_active_bytes "SVG bytes disguised as PNG" "chart.png" \
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

printf 'test_attachment_open.sh ok\n'
