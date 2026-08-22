import QtQuick
import qs.Commons
import qs.Ui

// The mark of the service a setup page is about.
//
// It answers "which mailbox am I adding" before any of the words do, which is
// the one question a setup page opens with. A provider with no mark of its own
// — IMAP is a protocol rather than a brand — draws nothing and takes no room,
// so the page above it needs no branch of its own.
//
// The file comes from `Registry.logo`, and the directory from here: the source
// is resolved against this component's own URL, so it is right whether the
// plugin was cloned into the Omarchy plugins directory or symlinked from a
// checkout. Nothing has to be told where it was installed.
Item {
  id: root

  // A file name in `assets/`, or "" for a provider that has none.
  required property string logo
  // The height. Width follows from the artwork, because a brand's own lockup
  // decides its own proportions: Gmail's mark is square, HEY's is a wordmark
  // more than twice as wide as it is tall, and forcing either into the other's
  // box would either crop it or strand it in empty space.
  property real size: Style.space(40)

  // What to draw for a provider with no artwork of its own. An envelope, in the
  // theme's colour, because that is what IMAP honestly is: a mailbox somewhere,
  // and no brand this could put a name to. Left empty where a missing mark
  // should simply take no room.
  property string fallbackIcon: ""
  property color fallbackColor: Color.foreground

  readonly property bool present: logo !== "" || fallbackIcon !== ""
  readonly property bool drawn: logo !== ""
  readonly property real aspect: drawn && mark.implicitHeight > 0
    ? mark.implicitWidth / mark.implicitHeight : 1

  visible: present
  width: present ? Math.round(size * aspect) : 0
  height: present ? size : 0
  implicitWidth: width
  implicitHeight: height

  Image {
    id: mark
    anchors.fill: parent
    visible: root.drawn
    source: root.drawn ? "../assets/" + root.logo : ""
    // Only the height is asked for, so the width — and with it `aspect` — comes
    // from the file rather than from an assumption here. Twice the drawn size,
    // because letting Qt scale the whole image down instead is how a logo comes
    // out soft on a HiDPI screen.
    sourceSize.height: Math.round(root.size * 2)
    fillMode: Image.PreserveAspectFit
    smooth: true
    // Loaded on the spot rather than asynchronously: these are a few kilobytes
    // each, and an async load reports no size for a frame — which is a logo
    // that starts square and jumps to its real width once the page is drawn.
    asynchronous: false
    cache: true
  }

  ActionIcon {
    anchors.centerIn: parent
    visible: !root.drawn && root.fallbackIcon !== ""
    name: root.fallbackIcon
    // A shade under the slot, so a drawn glyph and a piece of artwork carry the
    // same weight in a row: the artwork fills its box and a stroked glyph does
    // not.
    iconSize: Math.round(root.size * 0.8)
    color: root.fallbackColor
  }
}
