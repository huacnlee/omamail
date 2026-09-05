#!/bin/sh
# What jmap-srv.sh asks for, and what it does with what comes back.
#
# `resolvectl` and `dig` are replaced by stubs on a PATH holding nothing else,
# so these assert on the record the script prints and on the name it queried
# without needing a network, a resolver, or either tool to be installed — which
# is also the case the script exists to survive.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
# Resolved before the stubs take over PATH: the script under test needs no
# command but the two resolvers, and the shell that runs it has to be found on
# a PATH that holds neither.
shell=$(command -v sh)
script="$root/scripts/jmap-srv.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-jmap-srv-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP

# Nothing here reads or writes a user's configuration, and nothing may start
# doing so unnoticed: a home of its own is what keeps this test from finding
# the machine's own resolver settings or leaving anything behind.
HOME="$work/home"
XDG_CONFIG_HOME="$work/config"
XDG_CACHE_HOME="$work/cache"
XDG_DATA_HOME="$work/data"
XDG_STATE_HOME="$work/state"
export HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

mkdir -p "$work/bin"

# The record line each stub prints is the real thing: resolvectl writes the
# query name, the class and type, the four record fields and the interface it
# answered on; `dig +short` writes the four fields and a fully qualified
# target. Both were measured, and the difference between them is why the
# parser looks for the record's shape rather than counting fields.
cat > "$work/bin/resolvectl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_LOG"
[ "${RESOLVECTL_FAILS:-}" != "1" ] || {
  printf '%s: resolve call failed: no such record\n' "$4" >&2
  exit 1
}
printf '_jmap._tcp.example.org IN SRV 0 1 443 jmap.example.org     -- link: wlp9s0\n'
STUB
chmod +x "$work/bin/resolvectl"

cat > "$work/bin/dig" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB_LOG"
[ "${DIG_FAILS:-}" != "1" ] || exit 0
printf '0 1 443 fallback.example.org.\n'
STUB
chmod +x "$work/bin/dig"

# A PATH with only one of the two on it, for the case where the machine has
# only one of the two.
mkdir -p "$work/dig-only" "$work/none"
cp "$work/bin/dig" "$work/dig-only/dig"

failures=0
log="$work/queries"

# stdout only: what the script printed for the parser to read.
run() {
  bin=$1
  shift
  rm -f "$log"
  STUB_LOG="$log" PATH="$bin" "$shell" "$script" "$@"
}

equals() {
  description=$1
  actual=$2
  expected=$3
  if [ "$actual" = "$expected" ]; then
    printf '  ok   %s\n' "$description"
  else
    printf '  FAIL %s: expected "%s", got "%s"\n' "$description" "$expected" "$actual"
    failures=$(( failures + 1 ))
  fi
}

check() {
  description=$1
  haystack=$2
  needle=$3
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf '  ok   %s\n' "$description"
  else
    printf '  FAIL %s\n' "$description"
    printf '       expected to find: %s\n' "$needle"
    printf '       in:\n%s\n' "$haystack"
    failures=$(( failures + 1 ))
  fi
}

check_absent() {
  description=$1
  haystack=$2
  needle=$3
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf '  FAIL %s\n' "$description"
    printf '       did not expect: %s\n' "$needle"
    failures=$(( failures + 1 ))
  else
    printf '  ok   %s\n' "$description"
  fi
}

printf 'a record\n'

out=$(run "$work/bin" example.org)
equals "the record resolvectl printed is the whole of the answer" "$out" \
  "_jmap._tcp.example.org IN SRV 0 1 443 jmap.example.org     -- link: wlp9s0"
queries=$(cat "$log")
check "the service, the protocol and the domain make the name" "$queries" \
  "_jmap._tcp.example.org"
check "asked for an SRV record, with no legend around it" "$queries" \
  "query --type=SRV --legend=no"
check_absent "and dig is never run when resolvectl answered" "$queries" "+short"

printf 'no resolvectl\n'

out=$(run "$work/dig-only" example.org)
equals "dig answers for a machine without systemd-resolved" "$out" \
  "0 1 443 fallback.example.org."
check "and it is asked for the same name" "$(cat "$log")" "SRV _jmap._tcp.example.org"

printf 'resolvectl that cannot answer\n'

rm -f "$log"
out=$(STUB_LOG="$log" RESOLVECTL_FAILS=1 PATH="$work/bin" "$shell" "$script" example.org)
equals "a resolver that failed falls through to dig" "$out" "0 1 443 fallback.example.org."
check "both were asked" "$(cat "$log")" "+short"

printf 'no record\n'

rm -f "$log"
set +e
out=$(STUB_LOG="$log" RESOLVECTL_FAILS=1 DIG_FAILS=1 PATH="$work/bin" "$shell" "$script" example.org)
status=$?
set -e
equals "a domain with no _jmap._tcp record prints nothing" "$out" ""
equals "and that is not an error: it is the ordinary case" "$status" 0

rm -f "$log"
set +e
out=$(STUB_LOG="$log" PATH="$work/none" "$shell" "$script" example.org)
status=$?
set -e
equals "a machine with neither tool has no record either" "$out" ""
equals "and says so the same way" "$status" 0

printf 'what is not a domain\n'

refuse() {
  description=$1
  shift
  set +e
  out=$(STUB_LOG="$log" PATH="$work/bin" "$shell" "$script" "$@" 2>"$work/err")
  status=$?
  set -e
  if [ "$status" -eq 2 ] && [ -z "$out" ]; then
    printf '  ok   %s\n' "$description"
  else
    printf '  FAIL %s: expected exit 2 and no output, got %s and "%s"\n' \
      "$description" "$status" "$out"
    failures=$(( failures + 1 ))
  fi
}

# The domain reaches a resolver as an argument, so a value that is not a name
# is refused before it can be one — and refused rather than repaired, because a
# stripped name is a different name from the one somebody typed.
refuse "a domain with a shell metacharacter in it" 'example.org; rm -rf /'
refuse "a domain with a space in it" "example .org"
refuse "a domain with a slash in it" "example.org/jmap"
refuse "a full URL" "https://example.org"
refuse "a leading dot" ".example.org"
refuse "a trailing dot" "example.org."
refuse "an empty domain" ""
refuse "no domain at all"
refuse "two domains" example.org example.com

if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures"
  exit 1
fi
printf 'jmap-srv.sh ok\n'
