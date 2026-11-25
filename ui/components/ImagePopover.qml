import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../message/Html.js" as Html
import "../message/Images.js" as Images

// The message's pictures, floated over the reader one at a time.
//
// A picture in the body, a plain-text marker or a picture attachment opens it
// at that picture; the arrows page through every picture of the message, body
// first and then attachments. It opens at the size that shows the whole
// picture without enlarging a small one, and zooms from there.
//
// Only prepared raster `data:` URIs are ever drawn. Qt fetches a remote Image
// source itself, so anything else is refused here even if a caller forgets to
// go through the backend; pictures not yet prepared are asked for through
// `loadRequested` and arrive through `provide`.
Item {
  id: root

  required property color textColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  // The picture on screen. `source` is what is drawn; `requested` names what
  // was asked for, shown whether or not it was prepared, so a refusal names
  // the thing it refused.
  property string source: ""
  property string requested: ""
  property bool refused: false
  property bool loading: false
  // The bytes could not be fetched (the provider or the sender's server did
  // not answer), as opposed to bytes that arrived and are not a picture. The
  // viewer offers to try again rather than calling the picture unreadable.
  property bool failed: false
  // The attachment is larger than this window will prepare a picture from.
  property bool tooLarge: false
  // A sender's remote picture the reader has not asked for. Opening the viewer
  // on a marker asks for that one; paging to another does not fetch it, the
  // page offers "Load picture" instead.
  property bool awaitingConsent: false
  property var entries: []
  property int index: -1
  // Which opening of the viewer an answer belongs to. A picture that arrives
  // after the viewer closed or reopened on other pictures is not drawn.
  property int generation: 0
  readonly property var entry: index >= 0 && index < entries.length ? entries[index] : null
  // The line beside the zoom: a save's outcome, until the picture changes.
  // `statusDetail` is the whole of it (where the file went), on hover.
  property string status: ""
  property string statusDetail: ""

  // Scale against the picture's own pixels. `fitted` follows the window: it is
  // the size that shows the whole picture, and stays that size as the window
  // changes until the reader zooms.
  property real zoom: 1
  property bool fitted: true
  readonly property bool opened: sheet.opened

  signal loadRequested(var entry, int index)
  signal saveRequested(var entry)
  signal openRequested(var entry)

  anchors.fill: parent
  z: 60

  // One picture with no neighbours: what a plain-text marker used to open.
  function show(url) {
    showPrepared(url, url)
  }

  function showPrepared(requestedUrl, prepared) {
    var wanted = String(requestedUrl || "")
    if (wanted === "") return
    var data = String(prepared || "")
    openGallery([{ kind: "marker", requested: wanted, source: data, name: wanted, number: 1,
      settled: true }], 0)
  }

  function openGallery(list, at) {
    var copied = []
    for (var i = 0; i < (list || []).length; i++) {
      var item = list[i]
      copied.push({ kind: item.kind, requested: String(item.requested || ""),
        source: String(item.source || ""), name: String(item.name || ""),
        number: item.number, attachment: item.attachment, settled: item.settled === true,
        failed: false, consented: item.consented === true })
    }
    if (copied.length === 0) return
    generation++
    entries = copied
    sheet.open()
    showIndex(Math.max(0, Math.min(copied.length - 1, Math.floor(at) || 0)))
  }

  // The prepared bytes for one entry, or "" with `failure` "download" when
  // they could not be fetched and anything else when they were refused.
  function provide(at, data, failure) {
    if (at < 0 || at >= entries.length) return
    var prepared = String(data || "")
    var next = entries.slice(0)
    var ready = Html.isRasterDataImage(prepared)
    next[at].source = ready ? prepared : ""
    next[at].failed = !ready && failure === "download"
    next[at].tooLarge = !ready && failure === "large"
    // A failed download is not settled: the page keeps saying so, paging
    // back included, until Try again asks again.
    next[at].settled = ready || failure !== "download"
    entries = next
    if (at === index) present(next[at])
  }

  // "Load picture" on a sender's remote picture, or "Try again" after a
  // failed download: ask for this page now.
  function load() {
    if (!entry) return
    var next = entries.slice(0)
    next[index].consented = true
    next[index].failed = false
    entries = next
    present(next[index])
  }

  function present(item) {
    requested = item.requested !== "" ? item.requested : item.name
    loading = false
    awaitingConsent = false
    failed = item.failed === true
    tooLarge = item.tooLarge === true
    if (Html.isRasterDataImage(item.source)) {
      refused = false
      source = item.source
      return
    }
    source = ""
    // Only a marker naming a public http(s) address is a picture to fetch;
    // an unresolved cid:, a private host or a local path is not one, and no
    // Load picture or Try again could ever bring it.
    if (item.settled || item.kind === "body"
        || (item.kind === "marker" && Html.imageSourceKind(item.requested) !== "remote")) {
      refused = !tooLarge
      return
    }
    refused = false
    if (failed) return
    if (item.kind === "marker" && item.consented !== true) {
      awaitingConsent = true
      return
    }
    loading = true
    root.loadRequested(item, index)
  }

  function showIndex(at) {
    if (at < 0 || at >= entries.length) return
    index = at
    status = ""
    statusDetail = ""
    fitted = true
    zoom = 1
    present(entries[at])
  }

  function step(delta) {
    if (entries.length > 1) showIndex(Images.step(index, entries.length, delta))
  }

  function zoomBy(steps) {
    fitted = false
    zoom = Images.zoomBy(zoom, steps)
  }

  function fit() {
    fitted = true
    zoom = Images.fitScale(picture.implicitWidth, picture.implicitHeight,
      view.width, view.height)
  }

  function close() { sheet.close() }

  QQC.Popup {
    id: sheet
    parent: root
    modal: true
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    padding: Style.space(8)
    x: Style.space(24)
    y: Style.space(24)
    width: Math.max(Style.space(160), root.width - Style.space(48))
    height: Math.max(Style.space(160), root.height - Style.space(48))

    onClosed: {
      root.generation++
      root.source = ""
      root.requested = ""
      root.refused = false
      root.loading = false
      root.entries = []
      root.index = -1
      root.status = ""
      root.statusDetail = ""
    }

    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    // Keys are the popup's: an open popup takes them before the window's
    // shortcut map, so nothing in the reader fires underneath it. Escape is
    // the popup's own close.
    contentItem: Item {
      id: frame
      objectName: "imageViewerFrame"
      focus: true
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Left) root.step(-1)
        else if (event.key === Qt.Key_Right) root.step(1)
        else if (event.key === Qt.Key_Plus || event.key === Qt.Key_Equal) root.zoomBy(1)
        else if (event.key === Qt.Key_Minus) root.zoomBy(-1)
        else if (event.key === Qt.Key_0) root.fit()
        else return
        event.accepted = true
      }

      Text {
        id: caption
        objectName: "imageViewerName"
        anchors.left: parent.left
        anchors.right: count.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: closeButton.verticalCenter
        text: root.entry ? String(root.entry.name || root.requested) : root.requested
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        // The sender wrote this. Left as AutoText, a src with a tag in it is
        // markup Qt would lay out — and an <img> in it a fetch it would make.
        textFormat: Text.PlainText
        elide: Text.ElideMiddle
      }

      Text {
        id: count
        objectName: "imageViewerCounter"
        anchors.right: closeButton.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: closeButton.verticalCenter
        visible: root.entries.length > 1
        text: Images.counter(root.index, root.entries.length)
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        textFormat: Text.PlainText
      }

      IconButton {
        id: closeButton
        anchors.right: parent.right
        anchors.top: parent.top
        iconName: "close"
        tooltipText: "Close"
        foreground: root.dimColor
        hoverColor: root.textColor
        fontFamily: root.panelFontFamily
        onClicked: root.close()
      }

      Flickable {
        id: view
        objectName: "imageViewerView"
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: closeButton.bottom
        anchors.topMargin: Style.space(6)
        anchors.bottom: tools.top
        anchors.bottomMargin: Style.space(6)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        contentWidth: Math.max(width, picture.width)
        contentHeight: Math.max(height, picture.height)
        // Dragging moves a picture larger than the view; one that fits has
        // nowhere to go.
        interactive: picture.width > width || picture.height > height

        onWidthChanged: if (root.fitted) root.fit()
        onHeightChanged: if (root.fitted) root.fit()

        Image {
          id: picture
          objectName: "imageViewerPicture"
          source: root.source
          asynchronous: true
          cache: false
          smooth: true
          mipmap: root.zoom < 1
          // Bounds the decode of a format the backend does not shrink (GIF,
          // WebP, BMP): a larger one is decoded scaled down to this.
          sourceSize.width: 4096
          sourceSize.height: 4096
          width: implicitWidth * root.zoom
          height: implicitHeight * root.zoom
          x: Math.max(0, (view.width - width) / 2)
          y: Math.max(0, (view.height - height) / 2)
          onStatusChanged: if (status === Image.Ready && root.fitted) root.fit()
        }

        // Zoom with the wheel, keeping the point under the pointer still.
        WheelHandler {
          acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
          onWheel: function(event) {
            if (picture.status !== Image.Ready) return
            var before = root.zoom
            var px = view.contentX + point.position.x - picture.x
            var py = view.contentY + point.position.y - picture.y
            root.zoomBy(event.angleDelta.y > 0 ? 1 : -1)
            var ratio = root.zoom / before
            view.contentX = Math.max(0, Math.min(view.contentWidth - view.width,
              px * ratio + picture.x - point.position.x))
            view.contentY = Math.max(0, Math.min(view.contentHeight - view.height,
              py * ratio + picture.y - point.position.y))
          }
        }

        Text {
          id: noticeText
          objectName: "imageViewerNotice"
          x: (view.width - width) / 2
          y: (view.height - height) / 2
          width: Math.min(view.width - Style.space(20), Style.space(360))
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.WordWrap
          // Only while bytes are on their way: a prepared picture decodes too
          // fast for "Loading" to be anything but a flash over it.
          visible: root.refused || root.loading || root.failed || root.awaitingConsent || root.tooLarge
            || (root.source !== "" && picture.status === Image.Error)
          text: root.refused ? "That image is not a picture this can show"
            : root.tooLarge ? "That picture is too large to show here: open it in another app"
            : root.failed ? "That image could not be downloaded"
            : root.awaitingConsent ? "This picture is on the sender's server: loading it tells the sender this message was opened"
            : (picture.status === Image.Error ? "That image could not be loaded" : "Loading")
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          textFormat: Text.PlainText
        }

        // The page's own answer to the line above: fetch it now.
        Button {
          objectName: "imageViewerLoad"
          visible: root.awaitingConsent || root.failed
          x: (view.width - width) / 2
          y: noticeText.y + noticeText.height + Style.space(10)
          width: implicitWidth
          height: implicitHeight
          text: root.failed ? "Try again" : "Load picture"
          foreground: root.textColor
          bordered: true
          fontSize: Style.font.bodySmall
          focusable: true
          onClicked: root.load()
        }
      }

      Row {
        id: tools
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        spacing: Style.space(2)

        IconButton {
          objectName: "imageViewerPrevious"
          iconName: "chevronLeft"
          tooltipText: "Previous picture"
          enabled: root.entries.length > 1
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.step(-1)
        }
        IconButton {
          objectName: "imageViewerNext"
          iconName: "chevronRight"
          tooltipText: "Next picture"
          enabled: root.entries.length > 1
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.step(1)
        }
        Item { width: Style.space(10); height: 1 }
        IconButton {
          objectName: "imageViewerZoomOut"
          iconName: "zoomOut"
          tooltipText: "Zoom out"
          enabled: picture.status === Image.Ready
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.zoomBy(-1)
        }
        IconButton {
          objectName: "imageViewerFit"
          iconName: "fit"
          tooltipText: "Fit to window"
          enabled: picture.status === Image.Ready
          // Selected means "the picture is fitted", which says nothing while
          // there is no picture to fit.
          selected: root.fitted && picture.status === Image.Ready
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.fit()
        }
        IconButton {
          objectName: "imageViewerZoomIn"
          iconName: "zoomIn"
          tooltipText: "Zoom in"
          enabled: picture.status === Image.Ready
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.zoomBy(1)
        }
        Text {
          objectName: "imageViewerZoom"
          anchors.verticalCenter: parent.verticalCenter
          leftPadding: Style.space(6)
          text: picture.status === Image.Ready ? Math.round(root.zoom * 100) + "%" : ""
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          textFormat: Text.PlainText
        }
      }

      Text {
        objectName: "imageViewerStatus"
        anchors.left: tools.right
        anchors.leftMargin: Style.space(12)
        anchors.right: actions.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: tools.verticalCenter
        text: root.status
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        textFormat: Text.PlainText
        elide: Text.ElideMiddle

        HoverHandler { id: statusHover }
        PanelToolTip {
          objectName: "imageViewerStatusDetail"
          text: root.statusDetail
          visible: statusHover.hovered && root.statusDetail !== ""
        }
      }

      Row {
        id: actions
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        spacing: Style.space(2)

        // The file goes to the download folder under a name no other file
        // there has; the line beside the zoom says which.
        IconButton {
          objectName: "imageViewerSave"
          iconName: "download"
          tooltipText: "Save to Downloads"
          enabled: !!root.entry && (root.entry.kind === "attachment" || root.source !== "")
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.saveRequested(root.entry)
        }
        IconButton {
          objectName: "imageViewerOpen"
          iconName: "browser"
          tooltipText: "Open in another app..."
          enabled: !!root.entry && (root.entry.kind === "attachment" || root.source !== "")
          foreground: root.textColor
          fontFamily: root.panelFontFamily
          onClicked: root.openRequested(root.entry)
        }
      }
    }
  }
}
