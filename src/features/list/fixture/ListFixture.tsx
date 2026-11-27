// A window with only the message list, filled with canned rows and no backend:
// for looking at the list (`nsh run src/features/list/fixture/ListFixture.tsx`,
// or screenshots under `nsh test --target macos`). Nothing here is sent anywhere.
import { mount, signal, Storage, View } from "nsh";
import { Window } from "nsh/desktop";
import { prefs } from "../../../app/prefs";
import { app } from "../../../app/store";
import { useKeyRouter } from "../../../keys/router";
import { hydrateSummary, type Summary } from "../../../mail/listModel";
import { cx, Omarchy, setOmarchyFont, setThemeMode, Toaster } from "../../../ui";
import { startTheme } from "../../../ui/theme";
import { seedMailboxPreview } from "../../mailbox/store";
import { MessageList } from "../index";
import { listStore } from "../store";

const NOW = Date.now();
const MIN = 60000;

function row(id: string, fields: Record<string, unknown>): Summary {
  return hydrateSummary({ id, labelIds: ["INBOX"], ...fields }, new Date(NOW));
}

export const FIXTURE_ROWS: Summary[] = [
  row("m1", { from: { name: "Ada Lovelace" }, subject: "Notes on the analytical engine", snippet: "I have attached the corrected tables for the second section.", dateMs: NOW - 4 * MIN, unread: true }),
  row("m2", { from: { name: "Grace Hopper" }, subject: "Compiler review on Thursday", snippet: "Can we move the review to the afternoon?", dateMs: NOW - 52 * MIN, starred: true,
    thread: { id: "t2", count: 3, unread: false, flagged: true, memberIds: ["m2", "m2b", "m2c"] } }),
  row("m3", { from: { name: "Katherine Johnson" }, subject: "Trajectory figures, a very long subject line that has to elide before the time", snippet: "", dateMs: NOW - 3 * 60 * MIN, unread: true }),
  row("m4", { from: { email: "billing@example.com" }, subject: "Your invoice is ready", snippet: "Invoice 2026-11 for the period ending November 30.", dateMs: NOW - 26 * 60 * MIN }),
  row("m5", { from: { name: "Margaret Hamilton" }, subject: "Re: priority display", snippet: "The alarms behaved exactly as designed.", dateMs: NOW - 4 * 24 * 60 * MIN }),
  row("m6", { from: { name: "Radia Perlman" }, subject: "Spanning tree poem", snippet: "I think that I shall never see a graph more lovely than a tree.", dateMs: NOW - 40 * 24 * 60 * MIN }),
];

/** A long synthetic list (storage key "listFixture.many" = "1"): for scrolling and the cursor's reveal; "none" shows the empty list, "cjk" Chinese rows. */
const MANY_ROWS: Summary[] = FIXTURE_ROWS.concat(
  Array.from({ length: 74 }, (_, i) => row("n" + (i + 7), {
    from: { name: "Sender " + (i + 7) }, subject: "Synthetic message " + (i + 7), snippet: "Row " + (i + 7) + " of 80.",
    dateMs: NOW - (60 + i) * 24 * 60 * MIN, unread: i % 5 === 0,
  })),
);

/** Chinese senders, subjects and snippets (storage key "listFixture.many" = "cjk"): line height and elision. */
const CJK_ROWS: Summary[] = [
  row("c1", { from: { name: "王小明" }, subject: "季度评审", snippet: "请在周四之前提交材料，评审会在下午三点开始。", dateMs: NOW - 6 * MIN, unread: true,
    thread: { id: "tc1", count: 4, unread: true, flagged: false, memberIds: ["c1", "c1b", "c1c", "c1d"] } }),
  row("c2", { from: { name: "欧阳娜娜·国际业务发展与战略合作部高级经理" }, subject: "关于二〇二七年度亚太区域渠道合作伙伴计划的调整方案与执行时间表的说明", snippet: "附件为修订后的方案全文，请各位在本周五下班前反馈意见，逾期视为同意。", dateMs: NOW - 2 * 60 * MIN, starred: true }),
  row("c3", { from: { name: "李雷", email: "lilei@example.org" }, subject: "Hello 世界 😀 混合文字的主题", snippet: "日本語のテキストと한국어 텍스트も含まれています。", dateMs: NOW - 30 * 60 * MIN }),
];

/**
 * Two mailboxes in one list (storage key "listFixture.many" = "unified"): a
 * label as long as a usual address, and one far longer than a third of the row.
 */
const UNIFIED_ACCOUNTS = [
  { id: "fixture", email: "jane.doe@example.com", provider: "gmail", label: "" },
  { id: "imap:shared@example.org", email: "shared@example.org", provider: "imap", label: "Northwind Traders shared vendor-contracts mailbox" },
];
const UNIFIED_ROWS: Record<string, Summary[]> = {
  fixture: FIXTURE_ROWS.slice(0, 3),
  "imap:shared@example.org": [
    row("u1", { from: { name: "Lise Meitner" }, subject: "Purchase order 4471", snippet: "Signed copy attached.", dateMs: NOW - 9 * MIN, unread: true }),
    row("u2", { from: { name: "Emmy Noether" }, subject: "Renewal terms", snippet: "The new rates start in January.", dateMs: NOW - 90 * MIN }),
  ],
};

// Cut off before anything mounts: window preferences in memory, the list's
// preview rows, and the mailbox store's offline seed.
prefs.useMemory();
listStore.preview({ fixture: FIXTURE_ROWS });
seedMailboxPreview({});

mount(() => {
  // The palette from storage key "listFixture.theme": "light" Paper, "dark" Ink (default),
  // "omarchy" a fixed Omarchy palette (Tokyo Night; never the desktop's own).
  setThemeMode("dark");
  startTheme();
  void Storage.getItem("listFixture.theme").then((theme) => {
    if (theme === "light") setThemeMode("light");
    else if (theme === "omarchy") Omarchy.applyTheme("tokyo-night");
  }).catch(() => {});
  // Omarchy's base size, as shell.toml would set it ("listFixture.baseSize", e.g. "16").
  void Storage.getItem("listFixture.baseSize").then((size) => {
    const baseSize = Number(size);
    if (size && Number.isFinite(baseSize)) setOmarchyFont({ family: null, baseSize });
  }).catch(() => {});
  void Storage.getItem("listFixture.many").then((many) => {
    if (many === "1") listStore.preview({ fixture: MANY_ROWS });
    else if (many === "none") listStore.preview({ fixture: [] });
    else if (many === "cjk") listStore.preview({ fixture: CJK_ROWS });
    else if (many === "unified") {
      app.setAccounts(UNIFIED_ACCOUNTS);
      app.openAccount("");
      listStore.preview(UNIFIED_ROWS);
    }
  }).catch(() => {});
  // A wider list ("listFixture.wide" = "1"), as a usual window gives it.
  const wide = signal(false);
  void Storage.getItem("listFixture.wide").then((value) => wide.set(value === "1")).catch(() => {});
  useKeyRouter();
  app.setAccounts([{ id: "fixture", email: "jane@example.com", provider: "gmail", label: "Jane" }]);
  app.openAccount("fixture");
  return (
    <Window id="main" title="Message list" defaultSize={{ width: 680, height: 560 }}>
      {() => (
        <View class="flex-1 flex-row bg-background">
          <View class={cx(wide() ? "w-[520px]" : "w-96", "shrink min-w-0 border-r border-border")}>
            <MessageList />
          </View>
          {/* Somewhere for a test's pointer to rest off the rows. */}
          <View testID="fixture-blank" class="flex-1 min-w-12" />
          <Toaster />
        </View>
      )}
    </Window>
  );
});
