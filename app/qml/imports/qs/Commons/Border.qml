pragma Singleton
import QtQuick

QtObject {
  function controlSpec(state, foreground, accent) {
    return state === "selected"
      ? ({ color: Style.selectedStateColor(foreground, accent), width: Style.normalBorderWidth })
      : ({ color: Style.normalBorderFor(foreground, accent), width: Style.normalBorderWidth })
  }
  function flat(color, width) { return ({ color: color, width: width }) }
}
