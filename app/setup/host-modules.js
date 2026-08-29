// @ts-check

import { dispatch as gmailDispatch } from "omamail-gmail-setup";
import { dispatch as imapDispatch } from "omamail-imap-setup";
import { dispatch as heyDispatch } from "omamail-hey-setup";
import { createSetupAdapters } from "./adapters.js";

export const setupAdapters = createSetupAdapters({
  gmail: gmailDispatch,
  imap: imapDispatch,
  hey: heyDispatch,
});
