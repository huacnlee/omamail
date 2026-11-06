// Omarchy's shell keeps a plugin's panel only while it is open unless the
// manifest sets keepLoaded: each summon then rebuilds the whole QML
// composition and the window can appear only once that finishes.
// Measured on Omarchy 4.0.5: 1303-1653 ms per open without the key, 96-158 ms
// with it, the first window after the shell starts still taking ~380 ms.
const assert = require('assert')
const manifest = require('../../manifest.json')

assert(manifest.kinds.includes('panel'), 'the panel plugin is the one that pays this')
assert.strictEqual(manifest.keepLoaded, true,
  'without keepLoaded Omarchy destroys the panel between summons and rebuilds it on every open')
console.log('Panel activation: the panel stays loaded between summons passed')
