const assert = require('assert')
const { load } = require('./load')
const text = load('agent/ChatText.js')

assert.equal(text.render(''), '')
assert.equal(text.render(null), '')
assert.equal(text.render('Hello\nworld\n\nمرحبا 日本語'), '<p>Hello<br>world</p><p>مرحبا 日本語</p>')
assert.equal(text.render('**Bold** and `code`'), '<p><b>Bold</b> and <code>code</code></p>')
assert.equal(text.render('**bold `**` still bold**'), '<p><b>bold <code>**</code> still bold</b></p>')
assert.equal(text.render('`**literal**` and ``a ` b``'), '<p><code>**literal**</code> and <code>a ` b</code></p>')
assert.equal(text.render('x ' + '`'.repeat(65536)), '<p>x ' + '`'.repeat(65536) + '</p>')
assert.equal(text.render('unfinished **bold and `code'), '<p>unfinished **bold and `code</p>')
assert.equal(text.render('- First\n- **Second**'), '<p>- First<br>- <b>Second</b></p>')
assert.equal(text.render('Before\n```js\n  a < b\n**literal** `literal`\n```\nAfter'), '<p>Before</p><pre>  a &lt; b\n**literal** `literal`\n</pre><p>After</p>')
assert.equal(text.render('```\n  one\n\n日本語'), '<pre>  one\n\n日本語</pre>')
assert.equal(text.render('```\nline\n'), '<pre>line\n</pre>')
assert.equal(text.render('```'), '<pre></pre>')
assert.equal(text.render('~~~~lang\n```\nx\n~~~~'), '<pre>```\nx\n</pre>')
assert.equal(text.render('````\n```\nstill code\n````'), '<pre>```\nstill code\n</pre>')
assert.equal(text.render('a\r\nb\r\n\r\nc'), '<p>a<br>b</p><p>c</p>')

const attacks = [
  '<img src="https://example.test/pixel">',
  '<a href="file:///etc/passwd">open</a>',
  '<style>body { background:url(https://example.test/pixel) }</style>',
  '<iframe src="https://example.test"></iframe>',
  '&lt;img src=x&gt; &#60;img src=x&#62;',
  '![image](https://example.test/pixel) [link](file:///etc/passwd)',
  '**<img src=x>** `<a href=x>`',
  '```html\n<img src=x>\n</pre><img src=x>\n```',
  '```"><img src=x>\nsafe\n```'
]
for (const source of attacks) {
  const rendered = text.render(source)
  const tags = rendered.match(/<[^>]*>/g) || []
  for (const tag of tags) {
    assert.ok(/^<\/?(?:p|b|code|pre)>$|^<br>$/.test(tag), tag)
  }
  assert.ok(!/<(?:img|a|iframe|style|link)\b/i.test(rendered), rendered)
  assert.ok(!/<[^>]+\s(?:href|src|style)\s*=/i.test(rendered), rendered)
}
assert.equal(text.render('&lt;img src=x&gt;'), '<p>&amp;lt;img src=x&amp;gt;</p>')
assert.equal(text.render('[link](https://example.test)'), '<p>[link](https://example.test)</p>')
assert.equal(text.render('<b>source</b>'), '<p>&lt;b&gt;source&lt;/b&gt;</p>')
console.log('test_chat_text.js ok')
