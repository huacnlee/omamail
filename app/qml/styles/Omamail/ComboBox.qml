import QtQuick
import QtQuick.Templates as T
import qs.Commons

// The shell's Dropdown, drawn here: a platform ComboBox brings its own
// up/down arrows and its own type size, which read as a foreign control in a
// settings row whose other controls follow the shell's scale.
T.ComboBox {
  id: control

  readonly property color semanticForeground: palette.buttonText
  readonly property color semanticAccent: palette.highlight
  readonly property int chevronSize: Math.max(8, Math.round(Style.font.bodySmall * 0.7))

  implicitWidth: Style.spacing.dropdownWidth
  implicitHeight: Style.spacing.controlHeight
  leftPadding: Style.spacing.controlPaddingX
  rightPadding: Style.spacing.controlPaddingX * 2 + chevronSize
  font.pixelSize: Style.font.bodySmall

  contentItem: Text {
    text: control.displayText
    font: control.font
    color: control.semanticForeground
    verticalAlignment: Text.AlignVCenter
    elide: Text.ElideRight
    textFormat: Text.PlainText
  }

  indicator: Canvas {
    objectName: "omamail-combobox-chevron"
    x: control.width - width - Style.spacing.controlPaddingX
    y: (control.height - height) / 2
    width: control.chevronSize
    height: Math.round(control.chevronSize / 2) + 2
    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      ctx.strokeStyle = control.semanticForeground
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(1, 1)
      ctx.lineTo(width / 2, height - 1)
      ctx.lineTo(width - 1, 1)
      ctx.stroke()
    }
    Connections {
      target: control
      function onSemanticForegroundChanged() { parent.requestPaint() }
    }
  }

  // The trigger holds the selected fill while its list is open, so the list
  // reads as attached to the control that opened it.
  background: Rectangle {
    objectName: "omamail-combobox-background"
    radius: Style.cornerRadius
    color: control.pressed ? Style.pressedFillFor(control.semanticForeground, control.semanticAccent)
      : control.popup.visible ? Style.selectedFillFor(control.semanticForeground, control.semanticAccent)
      : control.visualFocus ? Style.focusFillFor(control.semanticForeground, control.semanticAccent)
      : control.hovered ? Style.hoverFillFor(control.semanticForeground, control.semanticAccent)
      : Style.normalFillFor(control.semanticForeground, control.semanticAccent)
    border.width: Style.normalBorderWidth
    border.color: control.visualFocus || control.hovered
      ? Style.hoverBorderFor(control.semanticForeground, control.semanticAccent)
      : Style.normalBorderFor(control.semanticForeground, control.semanticAccent)
  }

  popup: T.Popup {
    readonly property real below: control.mapToItem(null, 0, control.height).y
    readonly property real windowHeight: control.Window.window ? control.Window.window.height : below + implicitHeight
    // Below the trigger when it fits, above it when it does not, then kept
    // inside the window.
    y: below + implicitHeight <= windowHeight ? control.height + 2
      : Math.max(-control.mapToItem(null, 0, 0).y, -implicitHeight - 2)
    width: control.width
    implicitHeight: Math.min(contentItem.implicitHeight + topPadding + bottomPadding,
      Style.spacing.popupRowHeight * 8 + topPadding + bottomPadding)
    padding: 1

    contentItem: ListView {
      clip: true
      implicitHeight: contentHeight
      model: control.delegateModel
      currentIndex: control.highlightedIndex
      boundsBehavior: Flickable.StopAtBounds
    }

    background: Rectangle {
      color: Color.popups.background
      border.width: 1
      border.color: Color.popups.border
      radius: Style.cornerRadius
    }
  }
}
