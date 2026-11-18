import QtQuick
import "../account/Model.js" as Model

// Wheel and touchpad scrolling for a Flickable, macOS style.
//
// A Flickable answers each wheel event with a flick it then decelerates, so
// the distance depends on how the turn was chopped up rather than on how far
// the fingers or the wheel went. This handler takes the event from anything
// under the pointer (`CanTakeOverFromAnything`) and drives `contentY` itself,
// by `Model.wheelPixels`, in one of two ways:
//
// - A touchpad (any event carrying a scroll phase) moves the content with the
//   fingers, on the same frame. When the fingers lift (`ScrollEnd`) the
//   content coasts on at the speed it was going and decays the way AppKit's
//   momentum does; fingers back on the pad (`ScrollBegin`) catch it.
// - A mouse wheel (no phase) glides to where the notches add up to instead of
//   jumping there. Notches arriving mid-glide extend the same glide, so the
//   distance is still exactly the notches' worth, however they were chopped.
//
// Anything else moving the view — a drag, the keyboard cursor, a scripted
// scroll — wins: the glide or coast stops the moment `contentY` is not where
// this handler left it.
//
// A handler rather than an Item wrapping one. A Flickable reparents its
// visual children into its content, so an Item dropped inside would be a
// zero-sized thing scrolling along with the list and its handler would never
// see a wheel event. A handler is not reparented: it attaches to the
// Flickable, which is exactly what has to be got in front of.
WheelHandler {
  id: root

  required property Flickable view

  // Seconds for a wheel glide to close 63% of the way; ~4x this to land.
  property real glideTime: 0.05
  // AppKit-like momentum: velocity multiplies by this every millisecond.
  property real momentumDecay: 0.9965
  // Below this (px/s) a coast is over, and a lift slower than it never starts one.
  property real momentumFloor: 30
  // The finger speed is judged over the last this many milliseconds.
  property int velocityWindow: 90
  readonly property bool animating: frames.running

  blocking: true
  grabPermissions: PointerHandler.CanTakeOverFromAnything
  acceptedDevices: PointerDevice.AllDevices
  orientation: Qt.Vertical

  property string mode: ""        // "", "glide" or "coast"
  property real glideTarget: 0
  property real velocity: 0       // px/s, in the sense of wheelPixels: positive lowers contentY
  property real placedY: 0        // where this handler last put contentY
  property var samples: []        // [{ t, px }] while fingers are on the pad

  function bounds() {
    return Model.contentYBounds(view.originY, view.contentHeight, view.height,
      view.topMargin, view.bottomMargin)
  }

  function place(y) {
    var clamped = Model.clampContentY(y, bounds())
    view.contentY = clamped
    placedY = view.contentY
    return clamped
  }

  function stop() {
    mode = ""
    velocity = 0
    frames.stop()
  }

  // One wheel event's worth: `pixels` from Model.wheelPixels, `phase` a Qt.ScrollPhase.
  function take(pixels, phase) {
    if (!view) return
    var now = Date.now()
    var touchpad = phase !== undefined && phase !== Qt.NoScrollPhase
    if (touchpad) {
      if (phase === Qt.ScrollBegin) { stop(); samples = [] }
      if (mode !== "") stop()
      // A platform with momentum of its own (macOS) sends it as events after
      // the lift: follow them, and add no coast on top.
      if (phase === Qt.ScrollMomentum) {
        samples = []
        if (pixels !== 0) place(view.contentY - pixels)
        return
      }
      if (pixels !== 0) {
        place(view.contentY - pixels)
        var kept = []
        for (var i = 0; i < samples.length; i++)
          if (now - samples[i].t <= velocityWindow) kept.push(samples[i])
        kept.push({ t: now, px: pixels })
        samples = kept
      }
      if (phase === Qt.ScrollEnd) release(now)
      return
    }
    if (pixels === 0) return
    // A mouse wheel: extend the glide already under way, or start one.
    var from = mode === "glide" ? glideTarget : view.contentY
    glideTarget = Model.clampContentY(from - pixels, bounds())
    if (glideTarget === view.contentY) { stop(); return }
    mode = "glide"
    placedY = view.contentY
    frames.restart()
  }

  // Fingers off the pad: coast at the speed they were going, if any.
  function release(now) {
    var recent = []
    for (var i = 0; i < samples.length; i++)
      if (now - samples[i].t <= velocityWindow) recent.push(samples[i])
    samples = []
    // Speed is distance over the time it took: the oldest sample only marks
    // when that time started, so its own distance is not counted. Fewer than
    // two samples is a nudge, not a swipe, and does not coast.
    if (recent.length < 2) { stop(); return }
    var total = 0
    for (var j = 1; j < recent.length; j++) total += recent[j].px
    var span = Math.max(16, now - recent[0].t) / 1000
    velocity = total / span
    if (Math.abs(velocity) < momentumFloor) { stop(); return }
    mode = "coast"
    placedY = view.contentY
    frames.restart()
  }

  property FrameAnimation frames: FrameAnimation {
    onTriggered: {
      var view = root.view
      // Somebody else moved it: theirs is the newer intent.
      if (!view || view.dragging || Math.abs(view.contentY - root.placedY) > 0.5) {
        root.stop()
        return
      }
      var dt = Math.min(0.05, Math.max(0.001, frameTime))
      if (root.mode === "glide") {
        // The content can shrink under a glide (a list refresh); aim inside
        // what is reachable now, or the glide would chase a target forever.
        root.glideTarget = Model.clampContentY(root.glideTarget, root.bounds())
        var left = root.glideTarget - view.contentY
        if (Math.abs(left) < 0.5) { root.place(root.glideTarget); root.stop(); return }
        root.place(view.contentY + left * (1 - Math.exp(-dt / root.glideTime)))
        return
      }
      if (root.mode === "coast") {
        // The distance covered under exponential decay, exactly, so the coast
        // is the same length at 60 Hz and at 240 Hz.
        var k = -Math.log(root.momentumDecay) * 1000
        var next = root.velocity * Math.exp(-k * dt)
        var moved = (root.velocity - next) / k
        root.velocity = next
        var wanted = view.contentY - moved
        if (root.place(wanted) !== wanted || Math.abs(next) < root.momentumFloor) root.stop()
        return
      }
      root.stop()
    }
  }

  onWheel: function(event) {
    if (!root.view) return
    root.take(Model.wheelPixels(event.angleDelta.y, event.pixelDelta.y), event.phase)
    // Not dead despite `blocking`: a flick already in flight from a drag
    // goes on decelerating from where it was and fights every turn after.
    root.view.cancelFlick()
  }
}
