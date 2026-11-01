import QtQuick
import QtQuick.Effects
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "../account/People.js" as People

// The address book, as Outlook's People: the list on the left, filtered as you
// type, and the picked person on the right with what is known about them and
// the two things one looks a person up for: writing to them and finding what
// they sent. Saved contacts by default; "All" adds everyone the mailboxes
// have exchanged mail with.
Rectangle {
  id: root

  required property var service
  property color textColor: Commons.Color.foreground
  property color backgroundColor: Commons.Color.background
  property color accentColor: Commons.Color.accent
  // As the window's own dim: the text colour two thirds of the way over.
  property color dimColor: Qt.rgba(
    textColor.r * 0.68 + backgroundColor.r * 0.32,
    textColor.g * 0.68 + backgroundColor.g * 0.32,
    textColor.b * 0.68 + backgroundColor.b * 0.32, 1)
  property color borderColor: Style.normalBorderColor
  property string fontFamily: Style.font.family

  signal writeRequested(string recipient)
  signal mailsRequested(string address)
  signal copyRequested(string text)

  color: backgroundColor

  readonly property var book: service ? service.contactBook || null : null
  property bool savedOnly: true
  property string query: ""
  property string selectedId: ""
  readonly property var people: book ? book.people || [] : []
  readonly property var shown: People.filter(people, query, savedOnly)
  readonly property var selected: personById(selectedId)
  readonly property bool loading: !!book && (book.peopleLoading || book.loading)
  readonly property bool searchFocused: searchField.activeFocus
  property string photoData: ""

  function personById(id) {
    for (var i = 0; i < shown.length; i++) if (shown[i].id === id) return shown[i]
    return shown.length > 0 ? shown[0] : null
  }

  function refresh(force) {
    if (book) book.refreshPeople(force === true)
  }

  function move(step) {
    if (shown.length === 0) return
    var index = 0
    for (var i = 0; i < shown.length; i++) if (shown[i].id === (selected ? selected.id : "")) index = i
    index = Math.max(0, Math.min(shown.length - 1, index + step))
    selectedId = shown[index].id
    list.positionViewAtIndex(index, ListView.Contain)
  }

  function focusSearch() { searchField.forceActiveFocus() }

  // The window's address book keys; true when the keyboard should leave the
  // search field. Down there has no use of its own, so it goes to the list.
  function runKey(id) {
    if (id === "contactNext") { if (!searchFocused) move(1); return true }
    if (id === "contactPrevious") { move(-1); return true }
    if (id === "contactWrite") writeToSelected()
    else if (id === "contactMails") mailsOfSelected()
    else if (id === "contactSearch") focusSearch()
    return false
  }
  function leaveSearch() {
    if (searchField.text !== "") searchField.text = ""
  }

  function writeToSelected() {
    var to = People.recipient(selected)
    if (to !== "") writeRequested(to)
  }

  function mailsOfSelected() {
    var email = People.firstEmail(selected)
    if (email !== "") mailsRequested(email)
  }

  onVisibleChanged: if (visible) refresh(false)
  onSelectedChanged: {
    photoData = ""
    var person = selected
    if (!person || !person.photo || !book) return
    var wanted = person.id
    book.photo(person.photo, function(data) {
      if (root.selected && root.selected.id === wanted) root.photoData = data
    })
  }

  // ------------------------------------------------------------- the list
  Item {
    id: listSide
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    width: Math.max(Style.space(240), Math.min(Style.space(340), Math.round(root.width * 0.36)))

    Column {
      id: listHead
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(12)
      spacing: Style.space(8)

      Item {
        width: parent.width
        height: Style.space(26)

        Text {
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          text: "Contacts"
          color: root.textColor
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        Row {
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)

          Repeater {
            model: [{ label: "Saved", saved: true }, { label: "All", saved: false }]
            Rectangle {
              id: chip
              required property var modelData
              readonly property bool active: root.savedOnly === modelData.saved
              width: chipText.implicitWidth + Style.space(16)
              height: Style.space(22)
              radius: Math.min(4, Style.cornerRadius)
              color: active ? Qt.alpha(root.accentColor, 0.18) : "transparent"
              border.width: 1
              border.color: active ? root.accentColor : root.borderColor
              Text {
                id: chipText
                anchors.centerIn: parent
                text: chip.modelData.label
                color: chip.active ? root.textColor : root.dimColor
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.savedOnly = chip.modelData.saved
              }
            }
          }

          IconButton {
            iconName: "refresh"
            tooltipText: root.loading ? "Loading contacts" : "Reload contacts"
            foreground: root.dimColor
            hoverColor: root.textColor
            size: Style.space(22)
            fontFamily: root.fontFamily
            onClicked: root.refresh(true)
          }
        }
      }

      TextField {
        id: searchField
        objectName: "contacts-search"
        width: parent.width
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Search a name, address, phone or company"
        onTextChanged: root.query = text
      }

      Text {
        width: parent.width
        text: root.loading && root.people.length === 0 ? "Loading..."
          : (root.shown.length === 1 ? "1 contact" : root.shown.length + " contacts")
        color: root.dimColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    ListView {
      id: list
      objectName: "contacts-list"
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: listHead.bottom
      anchors.bottom: parent.bottom
      anchors.topMargin: Style.space(8)
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      model: root.shown

      delegate: Rectangle {
        id: row
        required property var modelData
        readonly property bool current: !!root.selected && root.selected.id === modelData.id
        width: ListView.view.width
        height: Style.space(48)
        color: current ? Qt.alpha(root.textColor, 0.12)
          : (rowMouse.containsMouse ? Qt.alpha(root.textColor, 0.06) : "transparent")

        Avatar {
          id: rowAvatar
          anchors.left: parent.left
          anchors.leftMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          size: Style.space(30)
          person: row.modelData
        }

        Column {
          anchors.left: rowAvatar.right
          anchors.right: parent.right
          anchors.leftMargin: Style.space(10)
          anchors.rightMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter

          Text {
            width: parent.width
            text: People.displayName(row.modelData)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.textColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: row.current
          }
          Text {
            width: parent.width
            visible: text !== ""
            text: People.subtitle(row.modelData)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: root.dimColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        MouseArea {
          id: rowMouse
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.selectedId = row.modelData.id
          onDoubleClicked: { root.selectedId = row.modelData.id; root.writeToSelected() }
        }
      }

      Text {
        anchors.centerIn: parent
        width: parent.width - Style.space(32)
        visible: root.shown.length === 0 && !(root.loading && root.people.length === 0)
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.WordWrap
        text: root.query !== "" ? "No contact matches"
          : (root.savedOnly ? "No saved contacts. \"All\" shows everyone you have written to." : "No contacts yet")
        color: root.dimColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Rectangle {
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: 1
      color: root.borderColor
    }
  }

  // ------------------------------------------------------------ the person
  Flickable {
    id: detail
    objectName: "contacts-detail"
    anchors.left: listSide.right
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    clip: true
    contentHeight: card.height + Style.space(48)
    boundsBehavior: Flickable.StopAtBounds
    visible: !!root.selected

    Column {
      id: card
      x: Style.space(32)
      y: Style.space(32)
      width: Math.min(detail.width - Style.space(64), Style.space(560))
      spacing: Style.space(18)

      Row {
        spacing: Style.space(16)

        Avatar {
          size: Style.space(72)
          person: root.selected
          photo: root.photoData
        }

        Column {
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)
          width: card.width - Style.space(88)

          Text {
            objectName: "contacts-detail-name"
            width: parent.width
            text: People.displayName(root.selected)
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.textColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            font.bold: true
          }
          Text {
            width: parent.width
            visible: text !== ""
            text: root.selected ? [root.selected.title,
                root.selected.name ? root.selected.organization : ""]
              .filter(function(v) { return !!v }).join(" · ") : ""
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.dimColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
          Text {
            visible: !!root.selected && root.selected.saved !== true
            text: "Not saved: someone your mailboxes have exchanged mail with"
            color: root.dimColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }

      Row {
        spacing: Style.space(8)
        visible: People.firstEmail(root.selected) !== ""

        Button {
          text: "Write · c"
          bordered: true
          foreground: root.textColor
          accent: root.accentColor
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          onClicked: root.writeToSelected()
        }
        Button {
          text: "Their mail · o"
          bordered: true
          foreground: root.dimColor
          accent: root.accentColor
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          onClicked: root.mailsOfSelected()
        }
      }

      Field {
        heading: "Email"
        entries: root.selected ? root.selected.emails || [] : []
        onActivated: function(value) { root.writeRequested(People.recipient(root.selected, value)) }
      }

      Field {
        heading: "Phone"
        entries: root.selected ? root.selected.phones || [] : []
        onActivated: function(value) { root.copyRequested(value) }
      }
    }
  }

  Text {
    anchors.centerIn: detail
    visible: !root.selected && root.shown.length > 0
    text: "Pick a contact"
    color: root.dimColor
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  // A photo through the backend, else the initials on a tint of the accent.
  component Avatar: Item {
    id: avatar
    property real size: Style.space(30)
    property var person: null
    property string photo: ""
    width: size
    height: size

    Rectangle {
      anchors.fill: parent
      radius: width / 2
      color: Qt.alpha(root.accentColor, 0.22)
      visible: avatarImage.status !== Image.Ready
      Text {
        anchors.centerIn: parent
        text: People.initials(avatar.person)
        color: root.textColor
        font.family: root.fontFamily
        font.pixelSize: Math.max(Style.font.caption, Math.round(avatar.size * 0.36))
        font.bold: true
      }
    }

    // The photo, masked to the badge's circle: a Rectangle's clip ignores its
    // radius, so the corners would show past the initials' round shape.
    Image {
      id: avatarImage
      anchors.fill: parent
      source: avatar.photo
      fillMode: Image.PreserveAspectCrop
      asynchronous: true
      visible: false
    }
    Rectangle {
      id: avatarMask
      anchors.fill: parent
      radius: width / 2
      visible: false
      layer.enabled: true
    }
    MultiEffect {
      anchors.fill: parent
      visible: avatarImage.status === Image.Ready
      source: avatarImage
      maskEnabled: true
      maskSource: avatarMask
    }
  }

  // A heading and its values, each one a click away from being used.
  component Field: Column {
    id: field
    property string heading: ""
    property var entries: []
    signal activated(string value)
    width: card.width
    spacing: Style.space(6)
    visible: entries.length > 0

    Text {
      text: field.heading
      color: root.dimColor
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }

    Repeater {
      model: field.entries
      Item {
        id: entry
        required property var modelData
        width: field.width
        height: Style.space(22)

        Text {
          id: entryValue
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          text: String(entry.modelData.value || "")
          textFormat: Text.PlainText
          color: entryMouse.containsMouse ? root.accentColor : root.textColor
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.underline: entryMouse.containsMouse
        }
        Text {
          anchors.left: entryValue.right
          anchors.leftMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          visible: text !== ""
          text: String(entry.modelData.type || "")
          // A custom label is the user's own text: never markup.
          textFormat: Text.PlainText
          color: root.dimColor
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
        MouseArea {
          id: entryMouse
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: entryValue.width
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: field.activated(String(entry.modelData.value || ""))
        }
      }
    }
  }
}
