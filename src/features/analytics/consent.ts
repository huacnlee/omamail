import { signal } from "nsh";
import { readAnalyticsConsent, writeAnalyticsConsent } from "../../backend/client";

const choice = signal<boolean | null | undefined>(undefined);
const saving = signal(false);

export const analyticsConsent = {
  choice,
  saving,
  async load() {
    const stored = await readAnalyticsConsent().catch(() => null);
    choice.set(stored === "true" ? true : stored === "false" ? false : null);
  },
  async save(allowed: boolean) {
    if (saving()) return;
    saving.set(true);
    // Stop collection immediately, including while the preference is saving.
    if (!allowed) choice.set(false);
    try {
      await writeAnalyticsConsent(allowed);
      choice.set(allowed);
    } finally {
      saving.set(false);
    }
  },
};
