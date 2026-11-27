// Settings' mailboxes: each one's name and sender name, its signature (typed,
// or imported from a file the backend cleans), and the list with Edit... and
// Add a mailbox.... Port of SettingsPage.qml's signature and mailbox parts.
//
// An imported signature is rebuilt by the backend (message.signatureImport):
// scripts, styles, handlers, frames, forms, remote images and unknown
// attributes do not survive, and the preview draws what was stored, rendered
// again with remote images off, so it is the sent thing that is shown.
import { Buffer } from "buffer";
import { cleanup, computed, effect, Image, Picker, signal, Text, untracked, View } from "nsh";
import { app } from "../../app/store";
import { call } from "../../backend/client";
import * as Accounts from "../../mail/accounts";
import { accountsStore } from "../../mail/accounts-store";
import * as Html from "../../mail/message/html";
import { Button, cx, Hint, SettingRow, Icon, Input, LINE, RADIUS, Select, sizedBox, Textarea, TEXT, TextView, type TextViewImage } from "../../ui";
import { ProviderMark } from "../accounts/parts";
import { mailboxStore } from "../mailbox/store";
import * as Model from "./model";

const SAVE_DELAY_MS = 500;

/** Mailboxes with an id: one part-way through being added has nothing to save against. */
const named = () => accountsStore.accounts().filter((a) => a.id !== "" && !a.pending);

/** Which mailbox the identity fields edit: the open one when there is one, else the first. */
function useSelection() {
  const chosen = signal("");
  const selected = computed(() => {
    const list = named();
    return list.find((a) => a.id === chosen()) ?? list.find((a) => a.id === app.account()?.id) ?? list[0] ?? null;
  });
  return { chosen, selected };
}

/** A text the user types into a field that saves a moment after they stop, and when the page closes. */
function debounced(save: (id: string, text: string) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { id: string; text: string } | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) save(pending.id, pending.text);
    pending = null;
  };
  cleanup(flush);
  return {
    queue(id: string, text: string) {
      if (pending && pending.id !== id) flush();
      pending = { id, text };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY_MS);
    },
    flush,
  };
}

/** Which mailbox the fields under it edit: a row like the others, shown when there is a choice. */
function MailboxPicker(props: { label: string; value: string; onChange: (id: string) => void }) {
  return (
    <If when={named().length > 1}>
      <SettingRow title={props.label}>
        <Select
          accessibilityLabel={props.label}
          items={named().map((a) => ({ value: a.id, label: a.email }))}
          value={props.value}
          onChange={(e) => props.onChange(e.value)}
        />
      </SettingRow>
    </If>
  );
}

// ---------------------------------------------------------------- names

export function IdentityFields() {
  const { chosen, selected } = useSelection();
  const name = signal("");
  const sender = signal("");
  const labels = debounced((id, text) => accountsStore.setLabel(id, text));
  const senders = debounced((id, text) => accountsStore.setSenderName(id, text));
  // The fields follow the mailbox chosen, not every registry write.
  effect(() => {
    const id = selected()?.id ?? "";
    untracked(() => {
      const row = accountsStore.find(id);
      name.set(row?.label ?? "");
      sender.set(row?.senderName ?? "");
    });
  });
  const id = () => selected()?.id ?? "";
  return (
    <If when={selected()}>
      <View>
        <MailboxPicker
          label="Mailbox"
          value={id()}
          onChange={(next) => {
            labels.flush();
            senders.flush();
            chosen.set(next);
          }}
        />
        <SettingRow
          title="Mailbox name"
          description="What this mailbox is called in Omamail — in the switcher, in this list, and beside every message in a combined view. Leave it empty to use the address. It is not sent to anyone."
          stacked
        >
          <Input
            testID="settings-mailbox-name"
            value={name()}
            placeholder={selected()?.email ?? ""}
            accessibilityLabel="Mailbox name"
            onChange={(e) => {
              name.set(e.value);
              labels.queue(id(), e.value);
            }}
            onSubmit={() => labels.flush()}
          />
        </SettingRow>
        <If when={Accounts.namesSender(selected()?.provider)}>
          <SettingRow
            title="Your name"
            description="Who your mail is from, as recipients see it beside this mailbox's address. Leave it empty to send the address alone."
            stacked
          >
            <Input
              testID="settings-sender-name"
              value={sender()}
              placeholder="Your name"
              accessibilityLabel="Your name"
              onChange={(e) => {
                sender.set(e.value);
                senders.queue(id(), e.value);
              }}
              onSubmit={() => senders.flush()}
            />
          </SettingRow>
        </If>
      </View>
    </If>
  );
}

// ---------------------------------------------------------------- signature

function importNote(result: any): string {
  if (result.problem) return String(result.problem);
  const parts: string[] = [];
  const images = Number(result.images) || 0;
  const dropped = Number(result.dropped) || 0;
  if (images > 0) parts.push(images + (images === 1 ? " image" : " images"));
  if (dropped > 0) parts.push(dropped + " unsafe or unsupported " + (dropped === 1 ? "part" : "parts") + " removed");
  return parts.length ? "Imported: " + parts.join(", ") : "Imported";
}

function kindOf(type: string, name: string): "image" | "html" | "" {
  const mime = String(type || "").toLowerCase();
  if (mime.indexOf("image/") === 0) return "image";
  if (mime === "text/html" || mime === "application/xhtml+xml" || /\.x?html?$/.test(String(name || "").toLowerCase())) return "html";
  return "";
}

/** Raster pictures already in the markup, nothing fetched. */
function SignatureImage(props: { image: TextViewImage }) {
  return (
    <If
      when={Html.isRasterDataImage(props.image.src)}
      else={
        <View class="flex-row items-center gap-1" accessibilityLabel={props.image.alt || "Image"}>
          <Icon name="image" size={12} class={TEXT.secondary} />
          <Text class={TEXT.caption}>{props.image.alt || "Image"}</Text>
        </View>
      }
    >
      <Image
        src={props.image.src}
        accessibilityLabel={props.image.alt || "Image"}
        style={{
          width: typeof props.image.width === "number" ? props.image.width : undefined,
          height: typeof props.image.height === "number" ? props.image.height : undefined,
          maxWidth: "100%",
        }}
      />
    </If>
  );
}

export function SignatureFields() {
  const { chosen, selected } = useSelection();
  const text = signal("");
  const importing = signal(false);
  const note = signal("");
  const failed = signal(false);
  const preview = signal("");
  const saves = debounced((id, value) => accountsStore.setSignature(id, value));
  let renderSerial = 0;
  let live = true;
  cleanup(() => (live = false));

  const id = () => selected()?.id ?? "";
  const storedHtml = () => selected()?.signatureHtml ?? "";

  effect(() => {
    const at = id();
    untracked(() => {
      text.set(accountsStore.find(at)?.signature ?? "");
      note.set("");
    });
  });

  // The preview is what was stored, rendered again with remote images off.
  effect(() => {
    const html = storedHtml();
    const serial = ++renderSerial;
    preview.set("");
    if (!html) return;
    void call<any>("message.render", { html, options: { allowRemoteImages: false, withReader: false } })
      .then((result) => {
        if (!live || serial !== renderSerial || !result?.document) return;
        preview.set(Html.toHtml(result.document));
      })
      .catch(() => {});
  });

  async function importSignature() {
    if (importing() || !id()) return;
    const owner = id();
    importing.set(true);
    note.set("");
    failed.set(false);
    try {
      const picked = await Picker.pickFiles({
        multiple: false,
        maxSize: 2 * 1024 * 1024,
        filters: [{ name: "Pictures and HTML", extensions: ["png", "jpg", "jpeg", "gif", "webp", "html", "htm", "xhtml"] }],
      });
      const item = picked[0];
      if (!item) return;
      if (item.status !== "read" || !item.file) {
        note.set("That file could not be read");
        failed.set(true);
        return;
      }
      const kind = kindOf(item.type, item.name);
      if (kind === "") {
        note.set("Choose a PNG, JPEG, GIF or WebP picture, or an HTML file");
        failed.set(true);
        return;
      }
      const bytes = Buffer.from(await item.file.arrayBuffer());
      const data = kind === "html" ? bytes.toString("utf8") : bytes.toString("base64");
      let imported: any;
      try {
        imported = await call<any>("message.signatureImport", { kind, data });
      } catch {
        imported = null;
      }
      if (!live) return;
      if (!imported) {
        note.set("That signature could not be imported");
        failed.set(true);
        return;
      }
      note.set(importNote(imported));
      failed.set(String(imported.problem || "") !== "");
      if (failed()) return;
      accountsStore.setSignatureHtml(owner, String(imported.html || ""));
      // The words go into the plain editor for text-only clients, when it is empty.
      const plain = String(imported.plain || "");
      if (owner === id() && plain !== "" && text().trim() === "") {
        text.set(plain);
        saves.queue(owner, plain);
        saves.flush();
      }
    } catch {
      note.set("That file could not be read");
      failed.set(true);
    } finally {
      if (live) importing.set(false);
    }
  }

  return (
    <If when={selected()}>
      <View testID="settings-signature-section">
        <MailboxPicker
          label="Signature for"
          value={id()}
          onChange={(next) => {
            saves.flush();
            chosen.set(next);
          }}
        />
        <SettingRow
          title="Signature"
          description="Sits under a new message, and above the quoted text in a reply. Sent as written — no separator line is added in front of it."
          stacked
        >
        <Textarea
          testID="settings-signature-editor"
          value={text()}
          rows={4}
          placeholder="No signature"
          accessibilityLabel="Signature"
          onChange={(e) => {
            text.set(e.value);
            saves.queue(id(), e.value);
          }}
        />
        <View class="flex-row flex-wrap gap-2">
          <Button
            testID="settings-signature-import"
            size="small"
            icon="file"
            label={importing() ? "Importing" : "Import from file..."}
            tooltip="A PNG, JPEG, GIF or WebP picture, or an HTML file"
            loading={importing()}
            disabled={importing() || !id()}
            onPress={() => void importSignature()}
          />
          <If when={storedHtml() !== ""}>
            <Button
              testID="settings-signature-remove-html"
              size="small"
              variant="ghost"
              label="Remove imported markup"
              onPress={() => {
                accountsStore.setSignatureHtml(id(), "");
                note.set("");
              }}
            />
          </If>
        </View>
        <If when={note() !== ""}>
          <Hint tone={failed() ? "danger" : "default"} text={note()} />
        </If>
        <If when={preview() !== ""}>
          <View testID="settings-signature-preview" class={cx("p-3 max-h-56 overflow-hidden bg-inset", LINE.border, RADIUS)}>
            <TextView html={preview()} links="report" renderImage={(image) => <SignatureImage image={image} />} />
          </View>
        </If>
        </SettingRow>
      </View>
    </If>
  );
}

// ---------------------------------------------------------------- the list

export function MailboxList() {
  // The session's state for the row: reported through app.setAccountStatus
  // by whoever runs the session, and the inbox count the mailbox watch keeps.
  function status(account: Accounts.Account) {
    const session = app.accounts().find((a) => a.id === account.id);
    return Model.mailboxRowStatus({
      email: account.email,
      named: String(account.label ?? "").trim() !== "",
      signedIn: session?.signedIn,
      error: session?.error,
      unread: mailboxStore.inboxUnread(account.id),
    });
  }
  function edit(account: Accounts.Account) {
    app.push("setup", { provider: account.provider, accountId: account.id });
  }
  // Rows like the settings rows (min 44, a hairline under each), not a card.
  return (
    <View>
      <View role="list">
        <Each of={named()} key={(a) => a.id}>
          {(account) => (
            <View
              testID={"settings-mailbox-" + account().id}
              class={cx(sizedBox("min-h-11", "min-h", 44), "flex-row items-center gap-3 py-2.5 border-b border-border")}
            >
              <ProviderMark provider={account().provider} size={20} />
              <View class="flex-1 gap-0.5">
                <Text class={cx(TEXT.body, "line-clamp-1")}>{String(account().label ?? "").trim() || account().email || "New mailbox"}</Text>
                <Text class={cx(TEXT.caption, "line-clamp-1", status(account()).error ? "text-danger" : "")}>
                  {status(account()).text}
                </Text>
              </View>
              <Button
                testID={"settings-mailbox-edit-" + account().id}
                size="small"
                label="Edit..."
                accessibilityLabel={"Edit " + account().email + "..."}
                onPress={() => edit(account())}
              />
            </View>
          )}
        </Each>
      </View>
      <View class="flex-row py-2.5">
        <Button testID="settings-add-mailbox" size="small" icon="plus" label="Add a mailbox..." onPress={() => app.push("picker")} />
      </View>
    </View>
  );
}
