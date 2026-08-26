#!/bin/sh
# Reads one file, or the clipboard's image, for a draft.
#
#   attachment.sh read <path>
#   attachment.sh clipboard <dir>
#   attachment.sh pick
#   attachment.sh forget <dir> <path>
#
# One JSON object on stdout. Quickshell's Process.write() never closes stdin,
# so nothing here reads it: the path is an argument, and the answer is one
# line so a collector waiting for the process to exit is enough.
#
# The 20 MiB ceiling is the same number Message.js refuses. A file that large
# already expands past Gmail's 25 MB encoded-message limit once the headers
# sit on it, so catching it here keeps the bytes off the GUI thread.
set -eu

MAX=20971520

fail_json() {
  printf '{"ok":false,"error":"%s"}\n' "$(json_escape "$1")"
  exit 0
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g'
}

basename_of() {
  printf '%s' "${1##*/}"
}

# GNU file --mime-type, with the extension as a fallback when `file` is
# missing or answers empty. The QML side still tokenises the type, so a
# surprising answer cannot become a header.
mime_of() {
  path=$1
  type=
  if command -v file >/dev/null 2>&1; then
    type=$(file -b --mime-type -- "$path" 2>/dev/null || true)
  fi
  case "$type" in
    */*) printf '%s' "$type" ;;
    *)
      case "$path" in
        *.png|*.PNG) printf 'image/png' ;;
        *.jpg|*.jpeg|*.JPG|*.JPEG) printf 'image/jpeg' ;;
        *.gif|*.GIF) printf 'image/gif' ;;
        *.webp|*.WEBP) printf 'image/webp' ;;
        *.pdf|*.PDF) printf 'application/pdf' ;;
        *.txt|*.TXT) printf 'text/plain' ;;
        *) printf 'application/octet-stream' ;;
      esac
      ;;
  esac
}

size_of() {
  wc -c < "$1" | tr -d ' '
}

emit_file() {
  path=$1
  filename=$(basename_of "$path")
  mime=$(mime_of "$path")
  size=$(size_of "$path")
  data=$(base64 < "$path" | tr -d '\n')
  printf '{"ok":true,"filename":"%s","mimeType":"%s","size":%s,"path":"%s","data":"%s"}\n' \
    "$(json_escape "$filename")" "$(json_escape "$mime")" "$size" \
    "$(json_escape "$path")" "$data"
}

has_newline() {
  # `printf '\n'` in a substitution is empty: the shell strips the trailing
  # newline. Counting characters against a pattern is the portable check.
  [ "$(printf '%s' "$1" | wc -l | tr -d ' ')" -gt 0 ]
}

read_file() {
  path=$1
  if [ -z "$path" ] || has_newline "$path"; then
    fail_json "That file could not be read"
  fi
  if [ ! -f "$path" ] || [ ! -r "$path" ]; then
    fail_json "That file could not be read"
  fi
  size=$(size_of "$path")
  if [ "$size" -gt "$MAX" ]; then
    fail_json "That file is larger than the 20 MB send limit"
  fi
  emit_file "$path"
}

inside_dir() {
  dir=$1
  path=$2
  case "$path" in
    "$dir"|"$dir"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# $1 dir, $2 mime, $3 extension, $4 name prefix (screenshot, paste). Writes
# the clipboard octets into dir and prints the same JSON `read` would. 1
# means this mime was not on the clipboard.
save_clipboard() {
  dir=$1
  mime=$2
  ext=$3
  prefix=${4:-screenshot}
  dest="$dir/$prefix-$(date +%Y%m%d-%H%M%S)-$$.$ext"
  wl_paste=$(command -v wl-paste || true)
  xclip=$(command -v xclip || true)
  if [ -n "$wl_paste" ]; then
    "$wl_paste" --type "$mime" > "$dest" 2>/dev/null || { rm -f "$dest"; return 1; }
  elif [ -n "$xclip" ]; then
    "$xclip" -selection clipboard -t "$mime" -o > "$dest" 2>/dev/null || { rm -f "$dest"; return 1; }
  else
    rm -f "$dest"
    return 1
  fi
  if [ ! -s "$dest" ]; then
    rm -f "$dest"
    return 1
  fi
  size=$(size_of "$dest")
  if [ "$size" -gt "$MAX" ]; then
    rm -f "$dest"
    fail_json "That file is larger than the 20 MB send limit"
  fi
  emit_file "$dest"
}

clipboard_image() {
  dir=$1
  if [ -z "$dir" ] || has_newline "$dir"; then
    fail_json "The compose cache could not be created"
  fi
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true

  types=
  wl_paste=$(command -v wl-paste || true)
  if [ -n "$wl_paste" ]; then
    types=$("$wl_paste" --list-types 2>/dev/null || true)
  fi

  printf '%s\n' "$types" | grep -qx 'image/png' && save_clipboard "$dir" image/png png screenshot && exit 0
  printf '%s\n' "$types" | grep -qx 'image/jpeg' && save_clipboard "$dir" image/jpeg jpg screenshot && exit 0
  printf '%s\n' "$types" | grep -qx 'image/jpg' && save_clipboard "$dir" image/jpg jpg screenshot && exit 0
  printf '%s\n' "$types" | grep -qx 'image/webp' && save_clipboard "$dir" image/webp webp screenshot && exit 0
  printf '%s\n' "$types" | grep -qx 'image/gif' && save_clipboard "$dir" image/gif gif screenshot && exit 0
  printf '%s\n' "$types" | grep -qx 'image/bmp' && save_clipboard "$dir" image/bmp bmp screenshot && exit 0

  # Files copied in Omafiles are text/uri-list, not an image. A screenshot
  # is checked first so a picture still pastes as a picture.
  printf '%s\n' "$types" | grep -qx 'text/uri-list' && clipboard_uris && exit 0
  printf '%s\n' "$types" | grep -qx 'application/pdf' && save_clipboard "$dir" application/pdf pdf paste && exit 0

  # No listed types (X11, or a compositor that does not report them): try PNG
  # and JPEG anyway. An empty grab is not an image.
  if [ -z "$types" ]; then
    save_clipboard "$dir" image/png png screenshot && exit 0
    save_clipboard "$dir" image/jpeg jpg screenshot && exit 0
  fi

  fail_json "no-image"
}

# file:// URIs from the clipboard, the way Omafiles copies a selection.
# Percent-decode only: "+" in a name is a plus, not a space.
uri_to_path() {
  u=$1
  case "$u" in
    file://localhost/*) u="file://${u#file://localhost}" ;;
  esac
  case "$u" in
    file://*) u=${u#file://} ;;
    *) return 1 ;;
  esac
  python3 -c 'import sys, urllib.parse; sys.stdout.buffer.write(urllib.parse.unquote_to_bytes(sys.argv[1]))' "$u"
}

clipboard_uris() {
  wl_paste=$(command -v wl-paste || true)
  [ -n "$wl_paste" ] || return 1
  list=$("$wl_paste" --type text/uri-list 2>/dev/null || true)
  [ -n "$list" ] || return 1
  paths=
  oldifs=$IFS
  IFS='
'
  set -f
  # shellcheck disable=SC2086
  set -- $list
  set +f
  IFS=$oldifs
  for uri in "$@"; do
    uri=$(printf '%s' "$uri" | tr -d '\r')
    case "$uri" in
      ''|\#*) continue ;;
    esac
    path=$(uri_to_path "$uri") || continue
    [ -n "$path" ] || continue
    if has_newline "$path"; then
      continue
    fi
    paths=$paths$path'
'
  done
  [ -n "$paths" ] || return 1
  emit_paths "$paths"
}

emit_paths() {
  list=$1
  json='{"ok":true,"paths":['
  sep=
  set -f
  oldifs=$IFS
  IFS='
'
  # shellcheck disable=SC2086
  set -- $list
  IFS=$oldifs
  set +f
  for path in "$@"; do
    [ -n "$path" ] || continue
    if has_newline "$path"; then
      continue
    fi
    json=$json$sep'"'$(json_escape "$path")'"'
    sep=,
  done
  json=$json']}'
  if [ "$sep" = "" ]; then
    fail_json "cancelled"
  fi
  printf '%s\n' "$json"
}

forget_file() {
  dir=$1
  path=$2
  if ! inside_dir "$dir" "$path"; then
    fail_json "That file is not a draft attachment"
  fi
  rm -f -- "$path"
  printf '{"ok":true}\n'
}

# A chooser in its own process. Qt's FileDialog aborted the whole shell
# inside GTK/DBus; this one dying leaves the draft up. omarchy-file-select
# talks to the desktop FileChooser portal. With Omafiles v1.2 that portal
# is Omafiles; without it the portal still answers from a separate GTK
# process, never from Quickshell.
pick_files() {
  list=
  if command -v omarchy-file-select >/dev/null 2>&1; then
    list=$(omarchy-file-select --title 'Attach files' --multiple 2>/dev/null || true)
  elif command -v zenity >/dev/null 2>&1; then
    list=$(zenity --file-selection --multiple --separator='
' --title='Attach files' 2>/dev/null || true)
  else
    fail_json "No file picker is available"
  fi
  if [ -z "$list" ]; then
    fail_json "cancelled"
  fi
  emit_paths "$list"
}

command=${1:-}
case "$command" in
  read)
    [ -n "${2:-}" ] || fail_json "That file could not be read"
    read_file "$2"
    ;;
  clipboard)
    [ -n "${2:-}" ] || fail_json "The compose cache could not be created"
    clipboard_image "$2"
    ;;
  pick)
    pick_files
    ;;
  forget)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || fail_json "That file is not a draft attachment"
    forget_file "$2" "$3"
    ;;
  *)
    printf '%s\n' 'usage: attachment.sh read <path> | clipboard <dir> | pick | forget <dir> <path>' >&2
    exit 2
    ;;
esac
