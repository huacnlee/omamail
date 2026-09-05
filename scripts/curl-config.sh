# Shared input boundary for the scripts that feed curl a config on stdin.
# Source this file after defining fail(). Validate the entire request BEFORE
# launching the config-builder | curl pipeline: a failure in its left-hand
# process cannot recall a request curl has already started.
validate_config_fields() {
  for config_encoded in "$@"; do
    # The sentinel keeps trailing LF bytes until after validation. Shells cannot
    # store NUL; the canonical base64 round trip detects any bytes they dropped.
    config_value=$(printf '%s' "$config_encoded" | base64 -d 2>/dev/null && printf '.') \
      || fail 'curl config: invalid base64 field'
    config_value=${config_value%.}
    config_roundtrip=$(printf '%s' "$config_value" | base64 | tr -d '\n')
    [ "$config_roundtrip" = "$config_encoded" ] \
      || fail 'curl config: field is not canonical text'
    # grep sees LF as a record separator, so it needs its own explicit check.
    config_nl='
'
    case $config_value in
      *"$config_nl"*) fail 'curl config: control character in field' ;;
    esac
    if printf '%s' "$config_value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
      fail 'curl config: control character in field'
    fi
  done
}
