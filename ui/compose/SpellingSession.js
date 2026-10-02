.pragma library

// Sonnet's ignore list is shared by the process. Notify every live adapter
// when it changes so each composer updates its cached underline ranges.
var adapters = []

function subscribe(adapter) { adapters.push(adapter) }

function unsubscribe(adapter) {
  var index = adapters.indexOf(adapter)
  if (index >= 0) adapters.splice(index, 1)
}

function changed() {
  var current = adapters.slice()
  for (var i = 0; i < current.length; i++) current[i].checkerChanged()
}
