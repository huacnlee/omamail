import assert from "node:assert/strict";

import OmarchyUiFixture from "../app/omarchy-ui.fixture.js";

const colors = new Proxy({}, { get: (_target, name) => `color:${String(name)}` });
const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
const radius = { sm: 4, md: 8 };
const cx = { theme: () => ({ colors, spacing, radius }) };

const fixture = new OmarchyUiFixture();
fixture.init();
const rendered = fixture.render(cx);
assert.equal(rendered.elementId, "application-frame");
assert.equal(rendered.childNodes.length, 3);

console.log("omarchy-ui render fixture passed");
