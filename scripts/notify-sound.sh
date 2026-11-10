#!/bin/sh
# The shell shows notifications silently, so the sound is played here. Stay
# quiet unless the shell confirms that Do Not Disturb is off, when no sound
# theme provides the sound, and while another account's sound is still playing.
[ -n "${XDG_RUNTIME_DIR-}" ] && [ "$(omarchy-shell notifications isDnd 2>/dev/null)" = off ] || exit 0
IFS=:
for dir in ${XDG_DATA_DIRS:-/usr/local/share:/usr/share}; do
  sound=$dir/sounds/freedesktop/stereo/message-new-instant.oga
  [ -f "$sound" ] || continue
  exec flock -n -E 0 "$XDG_RUNTIME_DIR/omamail-sound.lock" pw-play "$sound"
done
