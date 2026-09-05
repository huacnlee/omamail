#!/bin/sh
# Reads the `_jmap._tcp` SRV record for one domain, so sign-in can find a JMAP
# server nobody typed an address for (RFC 8620 section 2.2).
#
#   jmap-srv.sh example.org
#
# The domain is an argument rather than a base64 line on stdin, unlike every
# other script here: it is the domain half of the address the user typed into a
# visible field, it is not a secret, and there is nothing about it worth hiding
# from the process table. What it is checked for is shape — a name, not a shell
# word — before it can reach a resolver.
#
# ## Two tools, neither of them required
#
# `resolvectl` first, because systemd-resolved is what an Omarchy machine
# actually runs and it answers from the same cache the rest of the desktop
# uses. `dig` second, for a machine without it. Neither is a dependency: a
# machine with neither simply has no record, which is what a domain without one
# has too.
#
# ## No answer is no record
#
# The one thing this must not do is turn "there is no `_jmap._tcp` record" into
# an error, because that is the ordinary case — the reference Stalwart publishes
# none, and most servers never will. resolvectl exits non-zero and prints its
# own complaint for a name with no such record, `dig` exits 0 and prints
# nothing, and both mean the same thing here: nothing on stdout, exit 0, and
# discovery moves on to the domain's well-known URL.
#
# What it prints is whatever the tool said, one record per line, for
# `JmapProtocol.parseSrv` to read. The two tools disagree about the shape of a
# line and the parser knows both; a second normaliser here would be a second
# thing to keep in agreement with it.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

[ $# -eq 1 ] || fail 'jmap-srv.sh: usage: jmap-srv.sh <domain>'

domain=$1

# A hostname and nothing else. This value is pasted in front of a resolver
# query, so a space, a slash, a quote or a leading dash would be a chance to
# say something other than a name — and every character outside this set is
# refused rather than stripped, because a stripped name is a different name
# than the one somebody typed.
case "$domain" in
  "" | *[!A-Za-z0-9.-]* | -* | .* | *. | *..*)
    fail 'jmap-srv.sh: that is not a domain name' ;;
esac

name="_jmap._tcp.$domain"
answer=""

if command -v resolvectl >/dev/null 2>&1; then
  # `--legend=no` drops the "-- Information acquired via protocol DNS" footer.
  # The interface suffix it writes on the record line itself stays, and the
  # parser is written for it.
  answer=$(resolvectl query --type=SRV --legend=no "$name" 2>/dev/null) || answer=""
fi

if [ -z "$answer" ] && command -v dig >/dev/null 2>&1; then
  # One try and a short deadline: sign-in is waiting on this, and a resolver
  # that is not answering is the same answer as a domain with no record.
  answer=$(dig +short +time=3 +tries=1 SRV "$name" 2>/dev/null) || answer=""
fi

[ -z "$answer" ] || printf '%s\n' "$answer"
