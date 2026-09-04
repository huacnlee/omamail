#!/bin/sh
# Keeping an attachment: where it lands, what it is called, and what it must
# never do to a file that was already there.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/save-attachment.py"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-attachment-save-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP

failures=0

check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s\n' "$1"
    printf '       expected: %s\n' "$3"
    printf '       actual:   %s\n' "$2"
    failures=$(( failures + 1 ))
  fi
}

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

# base64url, the way a provider hands one over.
b64url_file() { base64 < "$1" | tr -d '\n=' | tr '/+' '_-'; }

save() {
  # <download dir> <filename> <path to the bytes> -> the saved path on stdout
  printf '%s\n%s\n' "$(b64 "$2")" "$(b64url_file "$3")" \
    | XDG_DOWNLOAD_DIR="$1" "$script"
}

printf 'save-attachment.py\n'

downloads="$work/Downloads"
mkdir -p "$downloads"
printf '\000\001\177\200\376\377statement bytes\n' > "$work/bytes"

# ------------------------------------------------------------------ the file

saved=$(save "$downloads" 'statement.pdf' "$work/bytes")
check "the saved path is reported" "$saved" "$downloads/statement.pdf"
if cmp -s "$work/bytes" "$saved"; then
  printf '  ok   every byte survives, including the ones that are not text\n'
else
  printf '  FAIL the saved file does not match the attachment\n'
  failures=$(( failures + 1 ))
fi
check "and it is private" "$(stat -c '%a' "$saved")" "600"

# ------------------------------------------------------- never overwriting

second=$(save "$downloads" 'statement.pdf' "$work/bytes")
check "the same name again is numbered" "$second" "$downloads/statement (2).pdf"
third=$(save "$downloads" 'statement.pdf' "$work/bytes")
check "and again" "$third" "$downloads/statement (3).pdf"
# Two messages carrying one name are two files, and the first must still be
# the first: this is the loss nobody notices until they need the file.
if [ -f "$downloads/statement.pdf" ]; then
  printf '  ok   the original is still there\n'
else
  printf '  FAIL the original was overwritten\n'
  failures=$(( failures + 1 ))
fi
# The number goes on the stem, not after the extension, or the file stops
# opening in what opens a PDF.
check "the extension stays last" "${second##*.}" "pdf"

# A name too long for the filesystem is shortened by giving up characters of
# the stem, never the extension: a name trimmed from the end takes the ".pdf"
# with it, and the file it names then opens in nothing. The limit counts bytes,
# so the accented name has to be checked as well as the plain one.
long_stem=$(printf 'A%.0s' $(seq 1 250))
long_saved=$(save "$downloads" "$long_stem.pdf" "$work/bytes")
long_name=${long_saved##*/}
check "a very long name keeps its extension" "${long_name##*.}" "pdf"
check "and is short enough to write" "$(printf '%s' "$long_name" | wc -c)" "240"

accented_stem=$(printf '\303\251%.0s' $(seq 1 200))
accented_saved=$(save "$downloads" "$accented_stem.pdf" "$work/bytes")
accented_name=${accented_saved##*/}
check "a long name of multi-byte characters keeps it too" "${accented_name##*.}" "pdf"
check "and is measured in bytes, not characters" \
  "$(printf '%s' "$accented_name" | wc -c)" "240"

# ------------------------------------------------- a name from a stranger

escape=$(save "$downloads" '../../etc/passwd' "$work/bytes")
check "a path cannot leave the folder" "$escape" "$downloads/passwd"

windows=$(save "$downloads" 'C:\\Users\\me\\notes.txt' "$work/bytes")
check "a Windows path is a filename too" "$windows" "$downloads/notes.txt"

# A newline in a filename is unreadable in every listing that shows it, and
# this one also has to survive being the first line of the request.
control=$(save "$downloads" 'two
lines.txt' "$work/bytes")
check "a control character becomes an underscore" "$(basename "$control")" "two_lines.txt"

nameless=$(save "$downloads" '..' "$work/bytes")
check "a name that is only dots is not a name" "$nameless" "$downloads/attachment"

# --------------------------------------------------------- where it lands

# The folder is created rather than refused: a fresh machine may not have one
# yet, and the alternative is telling the user to go and make it.
fresh="$work/fresh/nested/Downloads"
made=$(save "$fresh" 'report.txt' "$work/bytes")
check "a download folder that does not exist yet is created" "$made" "$fresh/report.txt"

# Read from user-dirs.dirs when the environment says nothing, because that is
# where the desktop keeps the answer.
mkdir -p "$work/home/.config" "$work/home/Papiery"
printf 'XDG_DOWNLOAD_DIR="$HOME/Papiery"\n' > "$work/home/.config/user-dirs.dirs"
configured=$(printf '%s\n%s\n' "$(b64 'z-katalogu.txt')" "$(b64url_file "$work/bytes")" \
  | env -u XDG_DOWNLOAD_DIR HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" "$script")
check "user-dirs.dirs names the folder" "$configured" "$work/home/Papiery/z-katalogu.txt"

# Nothing configured at all still saves, rather than failing.
mkdir -p "$work/bare"
bare=$(printf '%s\n%s\n' "$(b64 'anywhere.txt')" "$(b64url_file "$work/bytes")" \
  | env -u XDG_DOWNLOAD_DIR HOME="$work/bare" XDG_CONFIG_HOME="$work/bare/.config" "$script")
check "with nothing configured it still lands somewhere" "$bare" "$work/bare/Downloads/anywhere.txt"

# ------------------------------------------------------------- refusals

if printf '%s\n' "$(b64 'lonely.txt')" | XDG_DOWNLOAD_DIR="$downloads" "$script" >/dev/null 2>&1; then
  printf '  FAIL a request with no data is refused\n'
  failures=$(( failures + 1 ))
else
  printf '  ok   a request with no data is refused\n'
fi

if printf '%s\n%s\n' "$(b64 'bad.txt')" 'not base64 at all!!' \
  | XDG_DOWNLOAD_DIR="$downloads" "$script" >/dev/null 2>&1; then
  printf '  FAIL data that is not base64 is refused\n'
  failures=$(( failures + 1 ))
else
  printf '  ok   data that is not base64 is refused\n'
fi

# A refused save leaves nothing behind that looks like the attachment and
# opens as nothing.
if [ -f "$downloads/bad.txt" ]; then
  printf '  FAIL a refused save left a file behind\n'
  failures=$(( failures + 1 ))
else
  printf '  ok   a refused save leaves no half-written file\n'
fi

if [ "$failures" -eq 0 ]; then
  printf 'save-attachment.py ok\n'
else
  printf '%s failure(s)\n' "$failures" >&2
  exit 1
fi
