#!/bin/sh
# Makes Omamail the desktop's mail client, or hands the job back.
#
#   default-mail.sh on <plugin-dir>   claim mailto: and SUPER+SHIFT+E
#   default-mail.sh off               restore Omarchy's own email bindings
#   default-mail.sh status            print `default` or `not-default`
#
# Two things decide "which mail client" on Omarchy, and a switch that moved
# only one would leave the other opening HEY:
#
#   - the x-scheme-handler/mailto default, which register-mailto.sh owns
#   - SUPER+SHIFT+E and SUPER+SHIFT+ALT+E, overridden by a managed block in
#     ~/.config/hypr/bindings.lua (hl.unbind + o.bind, the documented pattern)
#
# Omarchy's own files are never touched. `off` removes the block and leaves the
# file byte-identical to what it was before `on`; the mailto default stays with
# Omamail because Omarchy ships no handler to give it back to.
set -eu

CONFIG_HOME=${XDG_CONFIG_HOME:-${HOME:?}/.config}
BINDINGS_FILE="$CONFIG_HOME/hypr/bindings.lua"
BLOCK_BEGIN="-- >>> omamail default mail client, do not edit by hand"
BLOCK_END="-- <<< omamail default mail client"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  fail 'usage: default-mail.sh on <plugin-dir> | off | status'
}

bindings_block() {
  cat <<EOF
$BLOCK_BEGIN
hl.unbind("SUPER + SHIFT + E")
hl.unbind("SUPER + SHIFT + ALT + E")
o.bind("SUPER + SHIFT + E", "Email", "omarchy-shell shell summon omamail '{}'")
o.bind("SUPER + SHIFT + ALT + E", "New email", "omarchy-shell shell summon omamail '{\"compose\":true}'")
$BLOCK_END
EOF
}

has_block() {
  [ -f "$BINDINGS_FILE" ] && grep -qxF -- "$BLOCK_BEGIN" "$BINDINGS_FILE"
}

remove_block() {
  has_block || return 0
  tmp=$(mktemp "$BINDINGS_FILE.XXXXXX")
  # Drop the block and the blank line added above it, so on then off
  # round-trips the file exactly.
  awk -v begin="$BLOCK_BEGIN" -v end="$BLOCK_END" '
    $0 == begin { inblock = 1; blanks = 0; next }
    inblock { if ($0 == end) inblock = 0; next }
    /^$/ { blanks++; next }
    { for (; blanks > 0; blanks--) print ""; print }
  ' "$BINDINGS_FILE" > "$tmp"
  mv "$tmp" "$BINDINGS_FILE"
}

add_block() {
  mkdir -p "$(dirname "$BINDINGS_FILE")"
  [ -f "$BINDINGS_FILE" ] || : > "$BINDINGS_FILE"
  remove_block
  printf '\n%s\n' "$(bindings_block)" >> "$BINDINGS_FILE"
}

reload_hyprland() {
  if [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] && command -v hyprctl >/dev/null 2>&1; then
    hyprctl reload >/dev/null 2>&1 || true
  fi
}

mailto_default() {
  command -v xdg-mime >/dev/null 2>&1 || return 0
  xdg-mime query default x-scheme-handler/mailto 2>/dev/null || true
}

case "${1:-}" in
  on)
    [ "$#" -eq 2 ] || usage
    plugin_dir=$(cd "$2" && pwd)
    sh "$plugin_dir/scripts/register-mailto.sh" "$plugin_dir" --claim-default
    add_block
    reload_hyprland
    printf '%s\n' 'Omamail is now the default mail client.'
    printf '%s\n' 'SUPER+SHIFT+E opens Omamail; SUPER+SHIFT+ALT+E starts a new message.'
    ;;
  off)
    [ "$#" -eq 1 ] || usage
    remove_block
    reload_hyprland
    printf '%s\n' "SUPER+SHIFT+E is Omarchy's own email binding again."
    ;;
  status)
    [ "$#" -eq 1 ] || usage
    if has_block && [ "$(mailto_default)" = omamail.desktop ]; then
      printf '%s\n' default
    else
      printf '%s\n' not-default
    fi
    ;;
  *) usage ;;
esac
