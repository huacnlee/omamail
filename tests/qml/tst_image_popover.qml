import QtQuick 2.15
import QtTest 1.3

Item {
  width: 400
  height: 300

  Loader {
    id: popoverLoader
    anchors.fill: parent
    Component.onCompleted: setSource("../../components/ImagePopover.qml", ({
      textColor: Qt.rgba(1, 1, 1, 1),
      dimColor: Qt.rgba(0.67, 0.67, 0.67, 1),
      popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1),
      popupBorderColor: Qt.rgba(0.47, 0.47, 0.47, 1),
      panelFontFamily: "monospace"
    }))
  }

  TestCase {
    name: "ImagePopover"
    when: windowShown

    function popover() {
      tryVerify(function() { return popoverLoader.status === Loader.Ready }, 1000)
      return popoverLoader.item
    }

    function test_a_remote_url_is_not_an_image_source() {
      var sheet = popover()
      sheet.show("https://cdn.example.com/a.png")
      compare(sheet.source, "", "Qt must not be handed a remote image URL")
      compare(sheet.refused, true)
      compare(sheet.requested, "https://cdn.example.com/a.png")
    }

    function test_prepared_raster_bytes_are_shown() {
      var sheet = popover()
      var data = "data:image/png;base64,iVBORw0KGgo="
      sheet.showPrepared("https://cdn.example.com/a.png", data)
      compare(sheet.source, data)
      compare(sheet.refused, false)
    }

    function test_svg_data_is_not_a_picture() {
      var sheet = popover()
      sheet.show("data:image/svg+xml;base64,AAA")
      compare(sheet.source, "")
      compare(sheet.refused, true)
    }

    function test_svg_disguised_as_png_is_not_a_picture() {
      var data = "data:image/png;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnPjwvU3ZnPg=="
      var sheet = popover()
      sheet.show(data)
      compare(sheet.source, "")
      compare(sheet.refused, true)
    }
  }
}
