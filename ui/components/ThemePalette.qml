import QtQuick
import Quickshell.Io
import "Palette.js" as Palette

QtObject {
  id: root

  required property color textColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor

  property var values: ({})
  readonly property var slots: Palette.keys()
  // The shell decides whether an Omarchy palette exists. Standalone hosts
  // leave this empty and use the semantic colours supplied by App.qml.
  property string palettePath: ""
  readonly property bool hasPalette: Object.keys(root.values).length > 0
  // A panel whose text is dark is a light panel, and a colour drawn on it has
  // to be dark enough to read. The generated identity colours are the only
  // place this matters: a theme's own palette is drawn as it comes.
  readonly property bool lightPanel: {
    var luminance = 0.299 * textColor.r + 0.587 * textColor.g + 0.114 * textColor.b
    return luminance < 0.5
  }

  function colorFor(key) {
    var normalized = Palette.normalizeKey(key)
    var value = values[normalized]
    // The theme's palette is used where it has colour. Where it is there but
    // carries none — the "white" theme's six slots are one grey ramp — the
    // slot's own hue is generated instead, because a picker that offers
    // "yellow" has to draw yellow rather than the grey the theme calls yellow.
    // A host that supplies no palette at all keeps the semantic fallbacks
    // below, which is what it drew before there was a palette to consult.
    if (root.hasPalette) {
      if (Palette.chromatic(root.values) && typeof value === "string" && value !== "")
        return value
      var hue = Palette.keyHue(normalized)
      if (hue !== null) return Palette.generatedHueColor(hue, root.lightPanel)
    }
    if (normalized === "accent") return root.accentColor
    if (normalized === "red") return root.urgentColor
    return root.dimColor
  }

  // A colour for an identity — a calendar source, a mailbox — chosen by a
  // stable hash of the identity itself, so the same one keeps its colour
  // across restarts and two that read alike do not. The theme's palette is
  // used where it has colour; where it is a grey ramp, or absent, a hue is
  // generated instead, because the one job of this colour is to tell two
  // identities apart.
  function colorForIdentity(identity) {
    var text = String(identity || "")
    if (root.hasPalette && Palette.chromatic(root.values))
      return root.colorFor(Palette.defaultKey(text))
    return Palette.generatedColor(text, root.lightPanel)
  }

  function reload() { paletteFile.reload() }

  onAccentColorChanged: reload()

  property FileView paletteFile: FileView {
    path: root.palettePath
    watchChanges: true
    printErrors: false
    onLoaded: root.values = Palette.parse(text())
    onFileChanged: reload()
    onLoadFailed: root.values = ({})
  }
}
