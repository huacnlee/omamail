pragma Singleton
import QtQuick

QtObject {
  function controlSpec(state, foreground, _accent) {
    return ({ color: foreground, width: state === "selected" ? 0 : 1 })
  }
  function flat(color, width) { return ({ color: color, width: width }) }
}
