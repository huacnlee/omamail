import QtQuick 2.15
import QtTest 1.3

// The version number belongs where somebody reporting a bug will already be
// looking: the empty reader. The pane it sits in is resized by the window and
// by the three-column-to-one collapse, so the interesting cases are geometric —
// it must not land on top of the centred block at any height, and the shortcut
// legend disappearing must not take it along.
Item {
  width: 400
  height: 400

  QtObject {
    id: mailService
    property string providerId: "gmail"
    property string mailboxKey: "inbox"
    property string searchQuery: ""
    property bool listLoaded: true
    property bool listLoading: false
    property var messages: [({ id: "m1" })]
    property string pluginName: "Omamail"
    property string version: "0.7.0"
  }

  Loader {
    id: blankSlateLoader
    width: 400
    height: 400
    Component.onCompleted: setSource("../../components/ReaderBlankSlate.qml", ({
      service: mailService,
      textColor: Qt.rgba(1, 1, 1, 1),
      accentColor: Qt.rgba(0.4, 0.6, 1, 1),
      dimColor: Qt.rgba(0.67, 0.67, 0.67, 1),
      dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1),
      panelFontFamily: "monospace"
    }))
  }

  // Nothing signed in yet, and the reader is handed no service at all.
  Loader {
    id: serviceless
    width: 400
    height: 400
    Component.onCompleted: setSource("../../components/ReaderBlankSlate.qml", ({
      service: null,
      textColor: Qt.rgba(1, 1, 1, 1),
      accentColor: Qt.rgba(0.4, 0.6, 1, 1),
      dimColor: Qt.rgba(0.67, 0.67, 0.67, 1),
      dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1),
      panelFontFamily: "monospace"
    }))
  }

  TestCase {
    name: "ReaderBlankSlate"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function slate() {
      tryCompare(blankSlateLoader, "status", Loader.Ready)
      return blankSlateLoader.item
    }

    function version() {
      var label = named(slate(), "reader-version")
      verify(label, "the blank slate must carry an identifiable version label")
      return label
    }

    // A Column repositions on the next polish, so a size assigned and read back
    // in the same frame reports the previous layout — and the stale answer is
    // the conservative one, which is how a broken guard passes unnoticed.
    // forceLayout settles it now rather than waiting on a frame, so the sweep
    // below stays a few milliseconds instead of a few seconds.
    function resize(width, height) {
      blankSlateLoader.width = width
      blankSlateLoader.height = height
      slate().children[0].forceLayout()
    }

    // The centred block and the bottom label are laid out by different anchors,
    // so only their coordinates can say whether they are printing on each other.
    function overlapping(label) {
      var column = label.parent.children[0]
      var columnBottom = column.y + column.height
      return label.visible && columnBottom > label.y
    }

    function init() {
      mailService.pluginName = "Omamail"
      mailService.version = "0.7.0"
      blankSlateLoader.width = 400
      blankSlateLoader.height = 400
    }

    function test_names_the_running_version() {
      var label = version()
      compare(label.text, "Omamail 0.7.0")
      verify(label.visible)
    }

    function test_follows_the_name_the_manifest_gives() {
      mailService.pluginName = "Forkmail"
      compare(version().text, "Forkmail 0.7.0")
    }

    function test_outlasts_the_shortcut_legend() {
      var label = version()
      resize(200, 240)
      verify(!slate().showLegend,
        "this pane must be too small for the legend, or the test proves nothing")
      verify(label.visible, "the version outlives the legend it is not part of")
    }

    // The heights either side of every threshold, one pixel at a time: a guard
    // derived against the short column silently fails once the legend doubles it.
    function test_never_prints_over_the_centred_block() {
      var label = version()
      for (var h = 120; h <= 520; h++) {
        resize(400, h)
        verify(!overlapping(label),
          "version label overlaps the centred column at height " + h
            + (slate().showLegend ? " (legend shown)" : ""))
      }
    }

    function test_says_nothing_without_a_version() {
      var label = version()
      mailService.version = ""
      verify(!label.visible)
    }

    function test_says_nothing_without_a_service() {
      tryCompare(serviceless, "status", Loader.Ready)
      var label = named(serviceless.item, "reader-version")
      verify(label, "the label exists even with no service behind it")
      verify(!label.visible)
    }
  }
}
