#!/bin/sh
# The message-body cache: one file per message, under one directory per account.
#
# Bodies used to live inside the account's store alongside the message list,
# which meant the whole cache was held in memory and re-serialised on the GUI
# thread every time anything in it changed. As files they cost nothing to keep,
# so the cache can be deep; the price is that eviction happens out here.
#
# Eviction is least-recently-used, and mtime is what carries "used": a read
# touches the file, so a message opened every morning outlives a hundred that
# arrived overnight.
#
# One line, read with `read` rather than `cat`: Quickshell's Process.write()
# never closes stdin, so anything waiting for EOF hangs forever.
set -eu

usage() {
  printf '%s\n' 'usage: body-cache.sh put|touch|prune|clear <dir> [name] [limit]' >&2
  exit 2
}

command=${1:-}
dir=${2:-}
[ -n "$command" ] && [ -n "$dir" ] || usage

# The caller builds names with a prefix-free escape, so a name can never contain
# a separator. Refusing one here as well means a bug up there cannot become a
# write outside the cache.
safe_name() {
  case "$1" in
    ''|*/*|.|..) return 1 ;;
  esac
  return 0
}

prune_dir() {
  keep=$1
  [ -d "$dir" ] || return 0
  # Newest first, then drop everything past the limit. Names carry no spaces or
  # newlines by construction, so a plain read splits them correctly.
  find "$dir" -maxdepth 1 -type f -name '*.json' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn \
    | tail -n +"$((keep + 1))" \
    | while IFS=' ' read -r _stamp path; do
        [ -n "$path" ] && rm -f -- "$path"
      done
}

umask 077

case "$command" in
  put)
    name=${3:-}
    limit=${4:-1000}
    safe_name "$name" || usage
    IFS= read -r payload
    [ -n "$payload" ] || exit 3
    mkdir -p "$dir"
    chmod 700 "$dir" 2>/dev/null || true
    tmp="$dir/.tmp.$$"
    printf '%s\n' "$payload" > "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$dir/$name"
    prune_dir "$limit"
    ;;
  touch)
    name=${3:-}
    safe_name "$name" || usage
    [ -f "$dir/$name" ] && touch -m -- "$dir/$name"
    ;;
  prune)
    prune_dir "${3:-1000}"
    ;;
  clear)
    # Only ever the directory this plugin built, and only if it looks like it.
    case "$dir" in
      */omamail/bodies/*) rm -rf -- "$dir" ;;
      *) usage ;;
    esac
    ;;
  *)
    usage
    ;;
esac
