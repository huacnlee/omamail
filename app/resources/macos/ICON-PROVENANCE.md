# Omamail macOS icon provenance

`omamail.icns` is a generated application resource for the standalone macOS
bundle. Its editable source is `omamail-macos.svg` in this directory. That SVG
places the existing Omamail mark on the documented Omarchy background and
accent colors with a macOS rounded-rectangle mask and safe area.

- Source SVG SHA-256: `acd7580c6c73145d21911af77ea28711a289a37a42fb625f41c240842fc3e500`
- Generated ICNS size: `350889` bytes
- Generated ICNS SHA-256: `b876fc5bdd346ee6cafff7c3163a2fa7e79fb1346dd410538d31f21698d84afc`
- ImageMagick: `7.1.0-10 Q16-HDRI arm`
- Apple `iconutil`: macOS 27.0

The source was rendered at 16, 32, 128, 256, and 512 points, including every
2x representation, using transparent PNG output. Apple `iconutil -c icns`
then assembled the ten images. `app/tests/test_identity.py` checks the ICNS
container, required size classes, and RGBA color type.
