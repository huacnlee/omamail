// The sidebar's lanes at the default width (184pt) at base 14 and 16
// (docs/DESIGN.md "NSH mailbox sidebar"): a nine-letter label at depth 1
// keeps its whole name, one depth is one 12pt step, and every count ends on
// the same right edge. On the offline preview: synthetic labels, no backend.
import { expect, test } from "nsh/test";
import { assertGuarded, openGuarded } from "../../testing/previewGuard";

async function preview(base: number) {
  const { app, guard } = await openGuarded("./fixtures/PreviewApp.tsx", { width: 560, height: 640, platform: "linux" });
  await app.waitFor("id:label-Clients/Northwind");
  if (base === 16) {
    const before = app.layout("id:mailbox-sidebar")!.width;
    await app.press("id:base-16");
    await app.waitUntil(() => app.layout("id:mailbox-sidebar")!.width > before);
  }
  return { app, guard, name: app.layout("id:label-Clients/Northwind >> text:Northwind")! };
}

for (const base of [14, 16]) {
  // With a fixed 36pt count lane the name got 52 of its 65pt at base 14:
  // the lane is content-sized now, and absent without a count.
  test(`a nine-letter label at depth 1 keeps its whole name, base ${base}`, async () => {
    const { app, guard, name } = await preview(base);
    expect(name.width).toBeGreaterThanOrEqual(app.layout("id:probe-northwind")!.width);
    assertGuarded(guard);
  });

  test(`one depth is one step and counts share a right edge, base ${base}`, async () => {
    const { app, guard, name } = await preview(base);
    const step = (12 * base) / 14;
    expect(Math.abs(name.x - app.layout("id:label-Clients >> text:Clients")!.x - step)).toBeLessThan(1);
    const right = (id: string) => {
      const c = app.layout(`id:${id}-count`)!;
      return c.x + c.width;
    };
    expect(right("label-Clients/Northwind")).toBe(right("label-Clients"));
    expect(right("label-Travel")).toBe(right("label-Clients"));
    // The name never runs under the count.
    expect(name.x + name.width).toBeLessThanOrEqual(app.layout("id:label-Clients/Northwind-count")!.x);
    assertGuarded(guard);
  });
}
