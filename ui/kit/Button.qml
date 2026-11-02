import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui as ShellUi
import "../theme"

// The shell's Button, drawn in the window's own theme.
//
// Three things are re-pointed. The fill comes from Paint, because the kit reads
// its state colours from Style's `[controls]` tokens — which Omarchy renders
// with the desktop theme's hex baked in, so a passed foreground is ignored. The
// border and the tooltip come from Paint for the same reason. And a chosen
// button keeps the shell's non-colour indication: its label stays bold.
//
// The shell derives that weight from `selected`, which also recolours the label
// from those same baked tokens (and keeps the colour private), so with a theme
// picked the button draws its own label instead: same font, same geometry, in
// the colour the caller passed. The base still paints the fill, the border, the
// press and the tooltip, and still owns the click, hover and focus contract.
//
// In Follow Omarchy nothing here applies: `selected` is `chosen`, the base
// draws its own label, and the button is the shell's button.
Item {
  id: root

  // The shell's public surface, forwarded below.
  property string text: ""
  property string iconText: ""
  property string tooltipText: ""
  property bool chosen: false
  property bool active: false
  property bool hasCursor: false
  property bool focusable: false
  property bool bordered: false
  property color foreground: Paint.active ? Paint.foreground : Commons.Color.foreground
  property color background: "transparent"
  property color accent: Paint.active ? Paint.accent : Commons.Color.accent
  property string fontFamily: Style.font.family
  property real fontSize: Style.font.body
  property real iconSize: Style.font.icon
  property real iconRotation: 0
  property bool iconSpinning: false
  property real horizontalPadding: Style.spacing.controlPaddingX
  property real verticalPadding: Style.spacing.controlPaddingY
  property bool leftAlign: false

  signal clicked()
  signal rightClicked()
  signal hovered(bool isHovered)

  // The shell derives the chosen state's weight from `selected`, so that stays
  // on in both modes: a chosen button is bold either way. What changes with a
  // theme picked is the colour: the shell paints a selected label from its
  // baked `[controls]` tokens and keeps that colour private, so the label drawn
  // from Paint is the wrapper's own (below) and the base's is not drawn.
  property bool selected: root.chosen

  readonly property bool themed: Paint.active
  readonly property bool hot: base.hot === true
  readonly property bool pressing: base.pressing === true

  // The colours the shell's button publishes, for the callers and tests that
  // read them. They are the base's own values, whichever mode it is in.
  readonly property alias color: base.color
  readonly property var border: base.border
  readonly property alias tooltipBackground: base.tooltipBackground
  readonly property alias tooltipForeground: base.tooltipForeground
  readonly property alias tooltipBorder: base.tooltipBorder

  // Geometry while themed, measured from the text that is actually drawn: the
  // base's own implicit size is measured from the label it is asked not to draw.
  readonly property real iconRoom: root.iconText !== ""
    ? iconMetrics.advanceWidth + (root.text !== "" ? Style.spacing.controlGap : 0) : 0
  readonly property real contentWidth: root.iconRoom + (root.text !== "" ? labelMetrics.advanceWidth : 0)
  // The widest border any visual state paints, so a themed button keeps its
  // neighbours still as it is hovered and focused, as the shell's does.
  readonly property real borderReserve: Math.max(
    root.focusable ? Paint.focusBorderWidth : 0,
    Paint.hoverBorderWidth,
    root.bordered || root.chosen ? Paint.normalBorderWidth : 0)
  readonly property real labelRoom: Math.max(0,
    root.width - root.horizontalPadding * 2 - root.borderReserve * 2 - root.iconRoom)

  implicitWidth: root.themed
    ? root.contentWidth + root.horizontalPadding * 2 + root.borderReserve * 2
    : base.implicitWidth
  implicitHeight: root.themed
    ? Math.max(labelMetrics.height, root.iconText !== "" ? iconMetrics.height : 0)
      + root.verticalPadding * 2 + root.borderReserve * 2
    : base.implicitHeight

  TextMetrics {
    id: labelMetrics
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
    font.bold: root.chosen
    text: root.text
  }

  TextMetrics {
    id: iconMetrics
    font.family: root.fontFamily
    font.pixelSize: root.iconSize
    text: root.iconText
  }

  ShellUi.Button {
    id: base
    anchors.fill: parent

    // The label and the icon are the wrapper's while themed, so the weight a
    // chosen button is owed does not depend on the base's selected colour.
    text: root.themed ? "" : root.text
    iconText: root.themed ? "" : root.iconText

    tooltipText: root.tooltipText
    selected: root.selected
    active: root.active
    hasCursor: root.hasCursor
    focusable: root.focusable
    bordered: root.bordered
    foreground: root.foreground
    background: root.background
    accent: root.accent
    fontFamily: root.fontFamily
    fontSize: root.fontSize
    iconSize: root.iconSize
    iconRotation: root.iconRotation
    iconSpinning: root.iconSpinning
    horizontalPadding: root.horizontalPadding
    verticalPadding: root.verticalPadding
    leftAlign: root.leftAlign

    // The focus stop is the wrapper, which hands focus here so the base's own
    // key handling and focus ring keep working.
    activeFocusOnTab: false

    onClicked: root.clicked()
    onRightClicked: root.rightClicked()
    onHovered: function(isHovered) { root.hovered(isHovered) }

    // The kit's own MouseArea is private, so a passive handler watches the same
    // press to know when to paint the pressed fill.
    readonly property bool pressing: press.pressed

    TapHandler {
      id: press
      acceptedButtons: Qt.LeftButton | Qt.RightButton
    }
  }

  activeFocusOnTab: root.focusable
  onActiveFocusChanged: if (root.activeFocus && !base.activeFocus) base.forceActiveFocus()

  Binding {
    target: base
    property: "color"
    when: Paint.active
    restoreMode: Binding.RestoreBindingOrValue
    // The kit's own ladder, in its own order: pressed, focus, hover, chosen,
    // then whatever background the caller set.
    value: base.pressing ? Paint.pressedFillFor(root.foreground, root.accent)
      : (root.focusable && base.activeFocus ? Paint.focusFillFor(root.foreground, root.accent)
        : (root.hot ? Paint.hoverFillFor(root.foreground, root.accent)
          : (root.chosen ? Paint.selectedFillFor(root.foreground, root.accent)
            : root.background)))
  }

  // The base's own label, in the theme's colour and at the weight the chosen
  // state is allowed to keep.
  Row {
    visible: root.themed
    anchors.verticalCenter: parent.verticalCenter
    anchors.horizontalCenter: root.leftAlign ? undefined : parent.horizontalCenter
    anchors.left: root.leftAlign ? parent.left : undefined
    anchors.leftMargin: root.leftAlign ? root.horizontalPadding + root.borderReserve : 0
    spacing: Style.spacing.controlGap

    Text {
      id: themedIcon
      visible: root.iconText !== ""
      text: root.iconText
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.iconSize
      rotation: root.iconSpinning ? 0 : root.iconRotation
      transformOrigin: Item.Center
      anchors.verticalCenter: parent.verticalCenter

      RotationAnimation on rotation {
        from: 0
        to: 360
        duration: Style.duration(900)
        loops: Animation.Infinite
        running: root.iconSpinning && !Style.reduceMotion
      }
    }

    Text {
      id: themedLabel
      visible: root.text !== ""
      text: root.text
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: root.fontSize
      font.bold: root.chosen
      width: Math.min(implicitWidth, root.labelRoom)
      elide: Text.ElideRight
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  Accessible.role: Accessible.Button
  Accessible.name: root.text !== "" ? root.text : root.tooltipText
}
