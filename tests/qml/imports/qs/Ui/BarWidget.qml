import QtQuick

// What a bar widget is, as far as a test needs: an Item the bar gives a
// reference to itself and a settings object. Stubbed rather than imported
// because the real one reaches for the running bar's geometry.
//
// It has to exist for `BarWidget.qml` in the plugin root to be testable at
// all: without it the root type resolves to the plugin's own file of the same
// name, and QML reports the file as instantiated recursively.
//
// Only what the real base declares. `barForeground` in particular is *not* a
// property of it — the plugin's own comment says reading it here yields
// undefined, and the bar is the source — so a stub that offered one would let
// exactly that regression pass.
Item {
  property QtObject bar: null
  property string moduleName: ""
  property var settings: ({})
  readonly property bool vertical: bar ? bar.vertical : false
  readonly property int barSize: 32
}
