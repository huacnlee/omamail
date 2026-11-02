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
// from those same baked tokens and keeps that colour private. So with a theme
// picked the label the base would draw is not asked for, and one in the
// window's colour is drawn here instead: same font, same weight, same geometry,
// in the caller's colour. The base still paints the fill, the border, the press
// and the tooltip, and still owns the click, hover and focus contract.
//
// In Follow Omarchy none of that happens: `selected` is `chosen`, the base
// draws its own label, and the button is the shell's button.
Item {
  id: root

  // The shell's public surface. `background` and `fontSize` stay unset so a
  // host's own default — the two hosts disagree on both — still applies.
  property string text: ""
  property string tooltipText: ""
  property bool chosen: false
  property bool hasCursor: false
  property bool focusable: false
  property bool bordered: false
  property color foreground: Paint.active ? Paint.foreground : Commons.Color.foreground
  property color accent: Paint.active ? Paint.accent : Commons.Color.accent
  property var background: undefined
  property var fontSize: undefined
  property string fontFamily: Style.font.family
  property real horizontalPadding: Style.spacing.controlPaddingX
  property real verticalPadding: Style.spacing.controlPaddingY
  property bool leftAlign: false

  signal clicked()
  signal hovered(bool isHovered)

  // The shell derives the chosen state's weight from `selected`, so it stays on
  // in both modes: a chosen button is bold either way.
  property bool selected: root.chosen

  readonly property bool themed: Paint.active
  readonly property bool hot: base.hot === true
  readonly property bool pressing: base.pressing === true
  readonly property real effectiveFontSize: root.fontSize !== undefined
    ? root.fontSize : Style.font.body
  readonly property color effectiveBackground: root.background !== undefined
    ? root.background : "transparent"

  // The colours the shell's button publishes, for the callers that read them.
  // They are the base's own values, whichever mode it is in.
  readonly property alias color: base.color
  readonly property var border: base.border
  readonly property var borderSpec: base.borderSpec
  readonly property color tooltipBackground: base.tooltipBackground !== undefined
    ? base.tooltipBackground : Commons.Color.tooltip.background
  readonly property color tooltipForeground: base.tooltipForeground !== undefined
    ? base.tooltipForeground : Commons.Color.tooltip.text
  readonly property color tooltipBorder: base.tooltipBorder !== undefined
    ? base.tooltipBorder : Commons.Color.tooltip.border

  // Geometry while themed, measured from the text that is actually drawn: the
  // base's own implicit size is measured from the label it is asked not to draw.
  // The widest border any visual state paints is reserved, so a themed button
  // keeps its neighbours still as it is hovered and focused.
  readonly property real borderReserve: Math.max(
    root.focusable ? Paint.focusBorderWidth : 0,
    Paint.hoverBorderWidth,
    root.bordered || root.chosen ? Paint.normalBorderWidth : 0)
  readonly property real labelRoom: Math.max(0,
    root.width - root.horizontalPadding * 2 - root.borderReserve * 2)

  implicitWidth: root.themed
    ? labelMetrics.advanceWidth + root.horizontalPadding * 2 + root.borderReserve * 2
    : base.implicitWidth
  implicitHeight: root.themed
    ? labelMetrics.height + root.verticalPadding * 2 + root.borderReserve * 2
    : base.implicitHeight

  TextMetrics {
    id: labelMetrics
    font.family: root.fontFamily
    font.pixelSize: root.effectiveFontSize
    font.bold: root.chosen
    text: root.text
  }

  ShellUi.Button {
    id: base
    anchors.fill: parent
    enabled: root.enabled

    // The label is the wrapper's while themed, so the weight a chosen button is
    // owed does not depend on the base's selected colour.
    text: root.themed ? "" : root.text

    tooltipText: root.tooltipText
    selected: root.selected
    hasCursor: root.hasCursor
    focusable: root.focusable
    bordered: root.bordered
    foreground: root.foreground
    accent: root.accent
    fontFamily: root.fontFamily
    horizontalPadding: root.horizontalPadding
    verticalPadding: root.verticalPadding
    leftAlign: root.leftAlign

    // The focus stop is the wrapper, which hands focus here so the base's own
    // key handling and focus ring keep working.
    activeFocusOnTab: false

    onClicked: root.clicked()
    onHovered: function(isHovered) { root.hovered(isHovered) }

    // The kit's own MouseArea is private, so a passive handler watches the same
    // press to know when to paint the pressed fill.
    readonly property bool pressing: press.pressed

    TapHandler {
      id: press
      acceptedButtons: Qt.LeftButton | Qt.RightButton
    }
  }

  // A caller that names either of these is obeyed; one that does not keeps the
  // host's own default.
  Binding {
    target: base
    property: "background"
    when: root.background !== undefined
    restoreMode: Binding.RestoreBindingOrValue
    value: root.background
  }

  Binding {
    target: base
    property: "fontSize"
    when: root.fontSize !== undefined
    restoreMode: Binding.RestoreBindingOrValue
    value: root.fontSize
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
            : root.effectiveBackground)))
  }

  // The label, in the window's colour and at the weight the chosen state keeps.
  Text {
    visible: root.themed
    anchors.horizontalCenter: root.leftAlign ? undefined : parent.horizontalCenter
    anchors.left: root.leftAlign ? parent.left : undefined
    anchors.leftMargin: root.leftAlign ? root.horizontalPadding + root.borderReserve : 0
    anchors.verticalCenter: parent.verticalCenter
    text: root.text
    textFormat: Text.PlainText
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: root.effectiveFontSize
    font.bold: root.chosen
    width: Math.min(implicitWidth, root.labelRoom)
    elide: Text.ElideRight
  }

  // The border is one of the places the shell's `[controls]` tokens reach, so a
  // picked theme supplies its own spec: the same geometry the live Style asks
  // for, in the theme's colour. The state ladder and the rule that a plain
  // button is borderless at rest are the shell's own.
  readonly property string themedBorderState: {
    if (root.focusable && base.activeFocus) return "focus"
    if (base.hot) return "hover"
    if (root.selected) return Paint.selectedBorderWidth > 0 ? "selected"
      : (root.bordered ? "normal" : "none")
    return root.bordered ? "normal" : "none"
  }

  Binding {
    target: base
    property: "borderSpec"
    when: Paint.active
    restoreMode: Binding.RestoreBindingOrValue
    value: root.themedBorderState === "none" ? Border.none()
      : Paint.controlSpec(root.themedBorderState, root.foreground, root.accent)
  }

  // The tooltip's palette is published by the shell's button and baked from the
  // same tokens, so it belongs to the window like everything else.
  Binding {
    target: base
    property: "tooltipBackground"
    when: Paint.active && base.tooltipBackground !== undefined
    restoreMode: Binding.RestoreBindingOrValue
    value: Paint.tooltipBackground
  }

  Binding {
    target: base
    property: "tooltipForeground"
    when: Paint.active && base.tooltipForeground !== undefined
    restoreMode: Binding.RestoreBindingOrValue
    value: Paint.tooltipText
  }

  Binding {
    target: base
    property: "tooltipBorder"
    when: Paint.active && base.tooltipBorder !== undefined
    restoreMode: Binding.RestoreBindingOrValue
    value: Paint.tooltipBorder
  }

  Accessible.role: Accessible.Button
  Accessible.name: root.text !== "" ? root.text : root.tooltipText
}
