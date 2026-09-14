# Omamail macOS icon provenance

`omamail.icns` and `../windows/omamail.ico` are generated application resources
for the standalone native bundles. The container source is `omamail-macos.svg`
in this directory. The complete internal logo layer comes directly from
`../icons/omamail.svg`; it is neither copied into the container SVG nor redrawn.
Both platforms use the same 1024px composition and differ only in container
format.

- Canonical Omamail SVG SHA-256: `3c780a0881ca98ffb717eb2877bf2e8a877deb9ddc3593a2bcca1d19139616e4`
- Container SVG SHA-256: `1277a2cf247b275a15961fb20175420abb5dfc5489acb95313f4f604c09b6e78`
- Generated ICNS size: `111809` bytes
- Generated ICNS SHA-256: `bd29ce1e72aa9db37ed5b1cb930956d2d933dc4426e7cea7f1b8baf2edb9262d`
- Generated ICO size: `106414` bytes
- Generated ICO SHA-256: `2562966adb272711ae0274f7eade7ef2680781bb4405182280a310658752131d`
- ImageMagick: `7.1.0-10 Q16-HDRI arm`
- Apple `iconutil`: macOS 27.0

Run `../icons/generate-native-icons.sh` on macOS to reproduce both files. The
script renders the complete canonical logo as a 596px layer over the 1024px
container, whose 824px plate follows Apple's app-icon grid so the Dock shows
it at the same size as its neighbours. It renders ICNS at 16, 32, 128, 256, and 512 points with every 2x
representation and ICO at 16, 32, 48, 64, 128, and 256 pixels.
