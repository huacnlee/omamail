// The ui text fields under an input method, for ime.test.tsx and a look:
// `nsh run src/ui/fixtures/ImeApp.tsx`. Each field reports what reached
// the app, and `imeComposing()` / `textInputActive()` show as text.
import { mount, signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";
import { ChipInput, type ChipToken } from "../ChipInput";
import { Button, Input, Textarea } from "../Controls";
import { imeComposing, textInputActive } from "../ime";
import { TextEditor } from "../TextEditor";
import { setThemeMode, startTheme } from "../theme";
import { TEXT } from "../tokens";

mount(() => {
  setThemeMode("dark");
  startTheme();
  const query = signal("");
  const submitted = signal<string[]>([]);
  const note = signal("");
  const body = signal("");
  const draft = signal("");
  const tokens = signal<ChipToken[]>([{ id: "ada", label: "Ada" }]);
  const shown = signal(true);
  const events = signal(0);
  return (
    <Window id="ime" title="IME" defaultSize={{ width: 520, height: 640 }}>
      {() => (
        <View class="gap-3 p-4 bg-background grow">
          <Text testID="composing" class={TEXT.body}>{`Composing: ${imeComposing() ? "yes" : "no"}`}</Text>
          <Text testID="active" class={TEXT.body}>{`Active: ${textInputActive() ? "yes" : "no"}`}</Text>
          <Text testID="submitted" class={TEXT.body}>{`Submitted: ${submitted().join("|") || "none"}`}</Text>
          <Text testID="events" class={TEXT.body}>{`Events: ${events()}`}</Text>
          <If when={shown()}>
            <Input
              testID="query"
              placeholder="Search mail"
              value={query()}
              onChange={(e) => query.set(e.value)}
              onSubmit={(e) => submitted.update((s) => [...s, e.value])}
              onCompositionChange={() => events.update((n) => n + 1)}
            />
          </If>
          <Textarea testID="note" placeholder="Notes" value={note()} onChange={(e) => note.set(e.value)} />
          <TextEditor testID="body" label="Message" placeholder="Write your message" value={body()} minHeight={80} onChange={(v) => body.set(v)} />
          <ChipInput
            testID="to"
            label="To"
            tokens={tokens()}
            value={draft()}
            onChange={(v) => draft.set(v)}
            onCommit={(t) => tokens.update((list) => [...list, { id: t, label: t }])}
            onRemove={(id) => tokens.update((list) => list.filter((t) => t.id !== id))}
          />
          <Text testID="tokens" class={TEXT.body}>{`Tokens: ${tokens().map((t) => t.label).join(",")}`}</Text>
          <Button testID="toggle" label="Toggle search" onPress={() => shown.update((s) => !s)} />
        </View>
      )}
    </Window>
  );
});
