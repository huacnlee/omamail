import QtQuick
import "../account/Model.js" as Model

// Wheel scrolling for a Flickable, because the Flickable's own is wrong on a
// mouse that reports finely — and, on a laptop, on two-finger scroll too.
//
// A Flickable answers each wheel event with a flick it then decelerates, so
// the distance depends on how the turn was chopped up rather than on how far
// the fingers or the wheel went. Chromium and the terminal compensate;
// this window did not, and crawled. The handler takes the event from
// anything under the pointer (`CanTakeOverFromAnything`) and moves
// `contentY` on the same frame by `Model.wheelPixels`.
//
// `pixelDelta` wins when the device reports it. Otherwise the notch mapping
// still applies, doubled so a 2x panel travels about as far as Chromium.
//
// A handler rather than an Item wrapping one. A Flickable reparents its
// visual children into its content, so an Item dropped inside would be a
// zero-sized thing scrolling along with the list and its handler would never
// see a wheel event. A handler is not reparented: it attaches to the
// Flickable, which is exactly what has to be got in front of.
WheelHandler {
  id: root

  required property Flickable view

  blocking: true
  grabPermissions: PointerHandler.CanTakeOverFromAnything
  acceptedDevices: PointerDevice.AllDevices
  orientation: Qt.Vertical

  onWheel: function(event) {
    if (!root.view) return
    root.view.contentY = Model.wheelScrollByPixels(root.view.contentY,
      Model.wheelPixels(event.angleDelta.y, event.pixelDelta.y),
      root.view.contentHeight, root.view.height,
      root.view.originY, root.view.topMargin, root.view.bottomMargin)
    // Not dead despite `blocking`: a flick already in flight from a drag
    // goes on decelerating from where it was and fights every turn after.
    root.view.cancelFlick()
  }
}
