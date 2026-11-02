import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Commons as Commons
import qs.Ui as ShellUi
import "../theme"

// The shell's Dropdown, drawn in the window's own theme.
//
// The kit paints the trigger's fill, its border and the row a keyboard cursor
// or pointer sits on from Style's `[controls]` tokens, which carry the desktop
// theme's hex — so nothing a caller passes reaches them. While a theme is
// picked the base is kept for what it is good at (its options, its value, its
// keyboard and pointer contract) and drawn at zero opacity and inert, and the
// same trigger and popup are drawn here from the base's public state.
//
// With Follow Omarchy none of that happens: the base is the dropdown, at full
// opacity, with its own popup.
Item {
  id: root

  property string label: ""
  property string value: ""
  property var options: []

  property color foreground: Paint.active ? Paint.popupText : Commons.Color.popups.text
  property color background: Paint.active ? Paint.popupBackground : Commons.Color.popups.background
  property color popupBorder: Paint.active ? Paint.popupBorder : Commons.Color.popups.border
  property color accent: Paint.active ? Paint.accent : Commons.Color.accent
  property string fontFamily: Style.font.family
  property int rowHeight: Style.spacing.controlHeight
  property int popupRowHeight: Style.spacing.popupRowHeight
  property bool showLabel: true
  property bool hasCursor: false

  readonly property bool themed: Paint.active
  readonly property bool popupOpen: root.themed ? themedPopup.opened : base.popupOpen === true
  // An open popup is not the same as an operable one: its rows only answer keys
  // while the list holds the keyboard. Stated here so a caller can wait for the
  // popup it just opened to be ready instead of guessing how long that takes.
  readonly property bool popupHasFocus: root.themed && themedPopup.opened && optionList.activeFocus

  function open() {
    if (root.themed) themedPopup.open()
    else if (typeof base.open === "function") base.open()
  }
  function close() {
    if (root.themed) themedPopup.close()
    else if (typeof base.close === "function") base.close()
  }
  function toggle() {
    if (root.themed) {
      if (themedPopup.opened) themedPopup.close()
      else themedPopup.open()
    } else if (typeof base.toggle === "function") base.toggle()
  }

  signal changed(string value)
  signal hovered(bool isHovered)

  function optionValue(option) {
    return (option && typeof option === "object") ? String(option.value) : String(option)
  }
  function optionLabel(option) {
    return (option && typeof option === "object") ? String(option.label) : String(option)
  }
  function currentLabel() {
    for (var i = 0; i < root.options.length; i++) {
      if (root.optionValue(root.options[i]) === root.value) return root.optionLabel(root.options[i])
    }
    return root.value
  }

  implicitWidth: base.implicitWidth
  implicitHeight: base.implicitHeight

  // A theme picked while the shell's popup is open would leave it drawn in the
  // desktop's colours; closing it is the only honest answer. The base is also
  // handed the value the window holds again, because choosing a row made it
  // assign its own and stop following the wrapper: without this the trigger
  // would still read the theme that was just left behind.
  onThemedChanged: {
    if (!root.themed) themedPopup.close()
    base.value = root.value
  }

  // The caller owns `value`, and the base is kept in step with it explicitly:
  // its own row selection assigns the property directly, which is what severs
  // a declarative binding.
  Binding {
    target: base
    property: "value"
    value: root.value
    restoreMode: Binding.RestoreBindingOrValue
  }

  ShellUi.Dropdown {
    id: base
    anchors.fill: parent
    opacity: root.themed ? 0 : 1
    enabled: !root.themed
    label: root.label
    options: root.options
    foreground: root.foreground
    background: root.background
    popupBorder: root.popupBorder
    accent: root.accent
    fontFamily: root.fontFamily
    rowHeight: root.rowHeight
    popupRowHeight: root.popupRowHeight
    showLabel: root.showLabel
    hasCursor: root.hasCursor
    onChanged: function(next) { root.changed(next) }
    onHovered: function(isHovered) { root.hovered(isHovered) }
  }

  Column {
    visible: root.themed
    width: parent.width
    spacing: Style.spacing.labelGap

    Text {
      id: themedLabel
      visible: root.showLabel && root.label !== ""
      width: parent.width
      textFormat: Text.PlainText
      text: root.label
      color: Qt.darker(root.foreground, 1.4)
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
      elide: Text.ElideRight
    }

    Rectangle {
      id: themedTrigger
      width: parent.width
      height: root.rowHeight
      radius: Style.cornerRadius

      readonly property bool focused: themedTrigger.activeFocus
      readonly property bool hot: themedHover.hovered || root.hasCursor

      color: Paint.controlFill(themedTrigger.focused, themedTrigger.hot, root.foreground, root.accent)
      border.width: Paint.controlBorderWidth(themedTrigger.focused, themedTrigger.hot)
      border.color: themedTrigger.focused
        ? Paint.focusBorderFor(root.foreground, root.accent)
        : (themedTrigger.hot
          ? Paint.hoverBorderFor(root.foreground, root.accent)
          : Paint.normalBorderFor(root.foreground, root.accent))

      activeFocusOnTab: true

      HoverHandler {
        id: themedHover
        onHoveredChanged: root.hovered(hovered)
      }

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
            || event.key === Qt.Key_Space || event.key === Qt.Key_Down) {
          if (themedPopup.opened) themedPopup.close()
          else themedPopup.open()
          event.accepted = true
        } else if (event.key === Qt.Key_Escape && themedPopup.opened) {
          themedPopup.close()
          event.accepted = true
        }
      }

      Text {
        textFormat: Text.PlainText
        anchors.left: parent.left
        anchors.right: themedChevron.left
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: themedTrigger.border.width + Style.spacing.controlPaddingX
        anchors.rightMargin: themedTrigger.border.width + Style.spacing.md
        text: root.currentLabel()
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
      }

      Text {
        id: themedChevron
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.rightMargin: themedTrigger.border.width + Style.spacing.controlGap
        text: "󰅀"
        color: Qt.darker(root.foreground, 1.2)
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: {
          themedTrigger.forceActiveFocus()
          if (themedPopup.opened) themedPopup.close()
          else themedPopup.open()
        }
      }

      QQC.Popup {
        id: themedPopup
        x: 0
        y: themedTrigger.height + Style.spacing.xxs
        width: themedTrigger.width
        implicitHeight: Math.min(root.options.length * root.popupRowHeight
            + Math.max(0, root.options.length - 1) * Style.spacing.labelGap + Style.spacing.xxs,
          root.popupRowHeight * 8 + 7 * Style.spacing.labelGap + Style.spacing.xxs)
        padding: Style.spacing.hairline
        leftPadding: Style.spacing.hairline * 2
        rightPadding: Style.spacing.hairline * 2
        topPadding: Style.spacing.hairline * 2
        bottomPadding: Style.spacing.hairline * 2
        focus: true

        background: Rectangle {
          color: root.background
          radius: Style.cornerRadius
          border.width: Paint.normalBorderWidth
          border.color: root.popupBorder
        }

        onOpened: {
          optionList.currentIndex = Math.max(0, optionList.indexOfValue(root.value))
          optionList.forceActiveFocus()
        }

        // An open popup that has lost the keyboard cannot be used: its rows
        // ignore keys and the trigger behind it answers them instead, so the
        // first Return closes the popup without choosing anything. Take the
        // keyboard back while the rows are the thing on screen.
        onActiveFocusChanged: if (opened && !optionList.activeFocus) optionList.forceActiveFocus()

        contentItem: ListView {
          id: optionList
          spacing: Style.spacing.labelGap

          Keys.priority: Keys.BeforeItem
          Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Escape) {
              themedPopup.close()
              event.accepted = true
            } else if (event.key === Qt.Key_Down || event.text === "j") {
              optionList.currentIndex = Math.min(root.options.length - 1, optionList.currentIndex + 1)
              event.accepted = true
            } else if (event.key === Qt.Key_Up || event.text === "k") {
              optionList.currentIndex = Math.max(0, optionList.currentIndex - 1)
              event.accepted = true
            } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
              optionList.selectCurrent()
              event.accepted = true
            }
          }
          implicitHeight: contentHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          model: root.options
          currentIndex: -1

          function indexOfValue(wanted) {
            for (var i = 0; i < root.options.length; i++) {
              if (root.optionValue(root.options[i]) === wanted) return i
            }
            return -1
          }

          function selectCurrent() {
            if (currentIndex < 0 || currentIndex >= root.options.length) return
            var next = root.optionValue(root.options[currentIndex])
            // Both values move together: the wrapper's for its caller, and the
            // base's so the trigger it draws in Follow mode never shows the
            // theme that was just left.
            root.value = next
            base.value = next
            root.changed(next)
            themedPopup.close()
          }

          delegate: Rectangle {
            required property var modelData
            required property int index
            width: optionList.width
            height: root.popupRowHeight
            color: index === optionList.currentIndex
              ? Paint.hoverFillFor(root.foreground, root.accent)
              : "transparent"

            Text {
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.spacing.controlPaddingX
              anchors.rightMargin: Style.spacing.controlPaddingX
              text: root.optionLabel(modelData)
              color: index === optionList.currentIndex
                ? Paint.hoverStateColor(root.foreground, root.accent) : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              elide: Text.ElideRight
            }

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onPositionChanged: optionList.currentIndex = parent.index
              onClicked: optionList.selectCurrent()
            }
          }
        }
      }
    }
  }
}
