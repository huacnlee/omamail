# Message rendering and direction

Required when touching message HTML, images, direction or outgoing MIME.

## HTML and resources

- Qt rich text can fetch resources, ignores `display:none`, and can draw stylesheet text. Sanitize before handing HTML to it: tokenize → tree → clean → serialize. Regex tag matching fails on quoted `>` characters. Do not turn this intentionally limited parser into an HTML5 tree builder that rearranges sender content.
- Keep `MAX_TREE_DEPTH`: recursive tree walks run on the shell's GUI thread. Sanitize once per message; derive formatted, reading and fallback plain-text views from that result. Cache sender HTML, not sanitizer output, so fixes apply to cached mail.
- Reading mode builds a fresh tree with text, checked `href`/`src`, and capped numeric image dimensions only. Do not copy sender class/style/color/alignment/background attributes.
- Escape text-node `<` and `>` when serializing: unwrapping and joining nodes can otherwise create new markup. Decode character references in style values before splitting declarations.
- HTML `background` is a resource URL, not a color. Refuse resource attributes before evaluating appearance preferences.
- Hidden-content detection must not treat container `font-size:0`, unclipped `max-height:0`, or `mso-hide:all` as universally hidden. Child font sizes, overflow and Outlook-only semantics matter.
- Reading-mode links allow `mailto:` and public-host HTTP(S). Refused addresses leave their labels visible.
- Never let Qt fetch original remote image URLs. With images enabled, fetch through `scripts/image_fetch.py` and `public_http.py`: checked public DNS, pinned connections, no redirects, size/deadline bounds, and supported raster signatures matching the declared type. Return only successful images as data URIs; omit pending/refused sources. Exclude tracking pixels and hidden images.
- Remote images default off. “Always show” grants the standing preference; Settings revokes it. See [security boundaries](SECURITY-BOUNDARIES.md).

## Direction and MIME

- Direction belongs to content, not interface mirroring. Leave Qt's natural paragraph direction and `Text.ElideRight` behavior alone when correct; use `undefined` to restore natural horizontal alignment.
- Ask `Direction.resolveSubject`, not `resolve`, for subjects: Latin reply prefixes otherwise override Arabic/Persian text.
- Qt honors `dir`, not CSS `direction`; `promoteDirection` translates it. Base direction and physical stylesheet sides must agree (`baseDirectionAttribute`) or list markers can disappear. A sender's explicit element direction overrides the base default.
- Outgoing right-to-left plain text gains a minimal HTML alternative: escaped text, preserved line breaks, `dir` on the body, no styling. Keep the unchanged plain part first. Left-to-right mail stays plain; calendar RSVPs keep exactly plain/calendar alternatives.
- `nestedBoundary` prefixes its tag so an inner delimiter cannot begin with the outer boundary and confuse multipart splitting.
- Qt ignores `dir` on table cells and their wrapping divs; retain natural first-strong-character resolution there.
