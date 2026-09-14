# Omamail macOS icon provenance

`omamail.icns` is a generated application resource for the standalone macOS
bundle. Its editable source is `omamail-macos.svg` in this directory. That SVG
places the red Omamail M on the documented Omarchy background color with a
full-size macOS rounded-rectangle container and transparent outer corners. The
mail-envelope outline used inside the application is intentionally omitted at
Dock size, where it read as an unrelated light frame.

- Source SVG SHA-256: `4e9cc52b3c3e8590f43805c155dd87ac38fbe14194f6f47f9b42e75d49b1295b`
- Generated ICNS size: `246889` bytes
- Generated ICNS SHA-256: `e8df633e8ac64aef6306663ef0ad782c9f8633e8c73c094bb83a7ca6b4a76e1c`
- ImageMagick: `7.1.0-10 Q16-HDRI arm`
- Apple `iconutil`: macOS 27.0

The source was rendered at 16, 32, 128, 256, and 512 points, including every
2x representation, using transparent PNG output. Apple `iconutil -c icns`
then assembled the ten images. `app/tests/test_identity.py` checks the ICNS
container, required size classes, and RGBA color type.
