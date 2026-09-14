# Omamail macOS icon provenance

`omamail.icns` and `../windows/omamail.ico` are generated application resources
for the standalone native bundles. The container source is `omamail-macos.svg`
in this directory. The complete internal logo layer comes directly from
`../icons/omamail.svg`; it is neither copied into the container SVG nor redrawn.
Both platforms use the same 1024px composition and differ only in container
format.

- Canonical Omamail SVG SHA-256: `3c780a0881ca98ffb717eb2877bf2e8a877deb9ddc3593a2bcca1d19139616e4`
- Container SVG SHA-256: `b900f47d96947727d17c150f0963f63ff09d476135e2fac440ca5fb5ead8f7fc`
- Generated ICNS size: `125257` bytes
- Generated ICNS SHA-256: `9d5df5d8d3fd0d6db8cbbb8f31bb38a44b185d37329de4d6b6f58c404980e22d`
- Generated ICO size: `107334` bytes
- Generated ICO SHA-256: `4762a6d6ab3b4d4136b3efccdff7ea0bc5157165605c1dda9fe19cca8bb2aaa7`
- ImageMagick: `7.1.0-10 Q16-HDRI arm`
- Apple `iconutil`: macOS 27.0

Run `../icons/generate-native-icons.sh` on macOS to reproduce both files. The
script renders the complete canonical logo as a 700px layer over the 1024px
container. It renders ICNS at 16, 32, 128, 256, and 512 points with every 2x
representation and ICO at 16, 32, 48, 64, 128, and 256 pixels.
