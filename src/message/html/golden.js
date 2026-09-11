// Capture the real production JS test corpus, including generated adversarial
// and large-message fixtures. This is a migration oracle, never runtime code.
const loader = require(process.cwd() + '/ui/tests/load.js');
const original = loader.load;
const baseline = require(process.cwd() + '/benchmarks/mail/baseline/ui/tests/load.js');
const cases = [];
loader.load = function(path) {
  const module = path === 'message/Html.js' ? baseline.load(path) : original(path);
  if (path === 'message/Html.js') {
    const sanitize = module.sanitize;
    module.sanitize = function(source, options) {
      const settings = options || {};
      // The old helper's absent-map fallback emitted live HTTP src. Production
      // callers already provided a map; native code deliberately refuses that
      // unsafe fallback. Compare the bounded, no-network policy in both paths.
      const comparable = Object.assign({}, settings);
      if (comparable.allowRemoteImages && !comparable.remoteImageData) comparable.remoteImageData = {};
      const result = sanitize(source, comparable);
      const expected = Object.assign({},result); delete expected.document; if (expected.plainText) expected.plainText = Object.assign({},expected.plainText,{bodyDirection:module.Direction.resolveBody(expected.plainText.text,"Auto")}); if (expected.reader) { expected.reader = Object.assign({},expected.reader); delete expected.reader.document; } cases.push({source, options: comparable, expected});
      return sanitize(source, options);
    };
  }
  return module;
};
const write = process.stdout.write;
process.stdout.write = () => true;
require(process.cwd() + '/ui/tests/test_html.js');
process.stdout.write = write;
process.stdout.write(JSON.stringify(cases));
