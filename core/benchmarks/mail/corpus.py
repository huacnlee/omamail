"""Deterministic synthetic mail, no mailbox or network access."""
import base64
import hashlib
import html


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


def transfer(data):
    encoded = base64.b64encode(data).decode()
    return '\r\n'.join(encoded[i:i+76] for i in range(0, len(encoded), 76))


def part(kind, data):
    return f'Content-Type: {kind}\r\nContent-Transfer-Encoding: base64\r\n\r\n{transfer(data)}'


def corpus(attachment_mib=2):
    header = ('From: Sender <sender@example.test>\r\nTo: Reader <reader@example.test>\r\n'
              'Subject: Synthetic benchmark\r\nDate: Tue, 01 Sep 2026 12:00:00 +0000\r\n'
              'Message-ID: <benchmark@example.test>\r\nMIME-Version: 1.0\r\n')
    plain = 'A small message.\r\nOne answer and a short signature.\r\n'
    newsletter = '<html><body><h1>Weekly synthetic report</h1>' + ''.join(
        f'<table><tr><td><h2>Section {i}</h2><p>Revenue and growth &amp; research {i}.</p>'
        f'<a href="https://example.test/report/{i}">Read the report</a>'
        f'<img src="https://images.example.test/{i}.png" width="640" height="320"></td></tr></table>'
        for i in range(1200)) + '<script>forbidden()</script><iframe src="https://example.test/embed"></iframe></body></html>'
    unicode = ('你好，世界。مرحبا بالعالم. שלום עולם. Καλημέρα κόσμε. Привет мир. 🙂\r\n' * 100)
    nested = part('text/html; charset=utf-8', b'<p>Deep alternative content</p>')
    for depth in range(8):
        boundary = f'nested-{depth}'
        nested = (f'Content-Type: multipart/alternative; boundary="{boundary}"\r\n\r\n'
                  f'--{boundary}\r\n{part("text/plain; charset=utf-8", b"Alternative text")}\r\n'
                  f'--{boundary}\r\n{nested}\r\n--{boundary}--\r\n')
    attachment = bytes(range(256)) * (attachment_mib * 4096)
    mixed = ('Content-Type: multipart/mixed; boundary="attachment-bench"\r\n\r\n'
             '--attachment-bench\r\n' + part('text/plain; charset=utf-8', b'Attached synthetic bytes.') +
             '\r\n--attachment-bench\r\nContent-Disposition: attachment; filename="synthetic.bin"\r\n' +
             part('application/octet-stream', attachment) + '\r\n--attachment-bench--\r\n')
    rows = [
        ('small_plain', part('text/plain; charset=utf-8', plain.encode()), '<p>'+html.escape(plain)+'</p>'),
        ('newsletter_html', part('text/html; charset=utf-8', newsletter.encode()), newsletter),
        ('nested_mime', nested, '<blockquote>' * 8 + '<p>Deep alternative content</p>' + '</blockquote>' * 8),
        ('large_attachment', mixed, '<p>Attached synthetic bytes.</p>'),
        ('unicode', part('text/plain; charset=utf-8', unicode.encode()), '<p>'+html.escape(unicode)+'</p>'),
    ]
    cases = []
    for name, body, markup in rows:
        raw = (header + body).encode('utf-8')
        cases.append(dict(name=name, raw=b64(raw), html=markup, bytes=len(raw),
                          htmlBytes=len(markup.encode()), sha256=hashlib.sha256(raw).hexdigest()))
    return cases
