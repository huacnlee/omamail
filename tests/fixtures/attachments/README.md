# Synthetic embedded invoice

`embedded-invoice.pdf` is a 1,092-byte PDF 1.7 created with pypdf 6.10.0: one blank 200 × 200 page and an uncompressed `factur-x.xml` embedded-file stream with `/Subtype /text#2Fxml` and `/AFRelationship /Alternative`. It contains only synthetic XML and no personal data or executable content. It exercises the PDF/A-3 invoice embedding mechanism, but is not a PDF/A or Factur-X conformance sample.

The fixture was independently read with `PdfReader(..., strict=True)`, checking one page and the exact embedded XML bytes, and `pdfinfo`. Tests never render an adversarial payload or launch its desktop handler.

`hidden-action.pdf` is an inert adversarial fixture: its cross-reference table points to a catalog physically inside a different stream, with an `OpenAction` JavaScript string. The fixture is only classified as bytes, never rendered or opened. Static inspection with strict pypdf and `pdfinfo -js` confirms the cross-reference can resolve the hidden action; the regression requires refusal even though the ordinary lexical walk skips that stream payload.

`opaque-action.pdf` exercises a tolerant-reader case: Poppler statically resolves a compressed action through an xref stream even though its object stream omits `/Type /ObjStm`. No viewer is launched. The exception therefore supports only one classic cross-reference table; object streams, xref streams, hybrid references, encryption and incremental-update references retain the ordinary refusal.

`embedded-invoice-crlf.pdf` is the same synthetic invoice with CRLF PDF framing, recalculated cross-reference offsets, and a UTF-8 BOM at the beginning of the XML stream. Strict pypdf reads the page and exact BOM-prefixed attachment bytes.
