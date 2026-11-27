// Omamail as the mail client: a `mailto:` link the system hands the app opens
// a draft filled from it, as the Qt client did when it was the default.
//
// How a link arrives. NSH lets an app claim only a scheme of its own
// (`nsh.json` "schemes" refuses `mailto`), so the system's mailto handler is
// set outside it, as Qt's was: on Linux the desktop entry declares
// `MimeType=x-scheme-handler/mailto;` and Settings > Default mail client makes
// it the default (ext/omamail-native mail_client.rs). The link then comes as a
// command-line argument:
// - to a running app, from a later launch (`gtk-launch`, `xdg-open mailto:..`),
//   which exits and hands its arguments here (nsh.json `"singleInstance":
//   true`, Application "secondInstance"); that is this file;
// - to the launch that starts the app: the native module keeps it
//   (`Backend.launchMailto()`, the first `mailto:` argument of at most 32 KiB,
//   no other argument), read once here at startup.
// macOS and Windows have no mailto default here (Qt's was Linux only).
//
// Anyone can start the app with any arguments, so they are untrusted: only an
// argument that is a `mailto:` link of a sane length is taken, it is read by
// compose's RFC 6068 parser (headers lose their line breaks; to, cc, bcc,
// subject and body only, never attachments or other headers), and the result
// only fills a draft. Nothing here sends.
import { Application } from "nsh/desktop";
import { Backend } from "omamail-native";
import { MAX_LENGTH } from "../mail/compose/mailto";
import { bringToFront } from "./windowFocus";

/** The longest link taken: compose's parser's own limit (32 KiB), checked
 * here too so an over-long argument is refused before anything reads it.
 * Past it the link is refused rather than cut, since a cut link says
 * something its sender did not. */
export const MAX_MAILTO_LENGTH = MAX_LENGTH;

/** The link to open, when `value` is one this app takes. */
export function acceptMailto(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_MAILTO_LENGTH) return null;
  if (!/^mailto:/i.test(text)) return null;
  return text;
}

/** The first argument of a launch that is a link to open; flags and files are
 * not links, and only one draft opens per launch. */
export function mailtoFromArgs(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  for (const arg of args.slice(0, 16)) {
    const link = acceptMailto(arg);
    if (link) return link;
  }
  return null;
}

/** The link this process was launched with, through the same filter as a
 * later launch's; null when there is none or the native module cannot say. */
export function launchLink(): string | null {
  try {
    const value = Backend.launchMailto() as unknown;
    return typeof value === "string" ? mailtoFromArgs([value]) : null;
  } catch {
    return null;
  }
}

/** Opens a draft for the link the app was launched with, and routes later
 * launches to this window: brought forward, and a draft opened when the
 * launch carried a `mailto:` link. Call once at startup; `open` is compose's
 * `openCompose`. */
export function startLaunchLinks(open: (request: { mailto: string }) => void): () => void {
  const first = launchLink();
  if (first) open({ mailto: first });
  try {
    return Application.on("secondInstance", (launch) => {
      bringToFront();
      const link = mailtoFromArgs(launch?.args);
      if (link) open({ mailto: link });
    });
  } catch {
    // A platform with one instance and no launch arguments (phones, the web).
    return () => {};
  }
}
