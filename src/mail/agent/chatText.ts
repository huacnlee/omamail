// The AI's reply as the dock draws it: paragraphs of plain text with bold and
// code spans, and fenced code blocks. Port of ui/agent/ChatText.js, which
// built a fixed-tag HTML string for Qt's rich text; here the result is data
// drawn with plain <Text> spans, so no markup in the reply is ever
// interpreted: no links, images or styles, whatever the model writes.

export interface ChatSpan {
  text: string;
  bold?: boolean;
  code?: boolean;
}
export type ChatBlock = { kind: "paragraph"; lines: ChatSpan[][] } | { kind: "code"; text: string };

const TICK = "\x60";

function codeEnd(text: string, start: number) {
  let end = start;
  while (text.charAt(end) === TICK) end++;
  const marker = text.slice(start, end);
  const close = text.indexOf(marker, end);
  return { start: end, end: close, after: close < 0 ? end : close + marker.length };
}

function boldEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text.charAt(index) === TICK) {
      index = codeEnd(text, index).after;
      continue;
    }
    if (text.slice(index, index + 2) === "**") return index;
    index++;
  }
  return -1;
}

function push(spans: ChatSpan[], text: string, bold: boolean, code: boolean) {
  if (text === "") return;
  const last = spans[spans.length - 1];
  if (last && !!last.bold === bold && !!last.code === code) {
    last.text += text;
    return;
  }
  const span: ChatSpan = { text };
  if (bold) span.bold = true;
  if (code) span.code = true;
  spans.push(span);
}

// Code content is copied as it is rather than read for emphasis again.
function inline(text: string, allowBold: boolean, bold: boolean, spans: ChatSpan[]) {
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) === TICK) {
      const code = codeEnd(text, index);
      if (code.end >= 0) {
        push(spans, text.slice(code.start, code.end), bold, true);
        index = code.after;
        continue;
      }
      push(spans, text.slice(index, code.start), bold, false);
      index = code.start;
      continue;
    }
    if (allowBold && text.slice(index, index + 2) === "**") {
      const close = boldEnd(text, index + 2);
      if (close > index + 2) {
        inline(text.slice(index + 2, close), false, true, spans);
        index = close + 2;
        continue;
      }
    }
    push(spans, text.charAt(index), bold, false);
    index++;
  }
}

export function inlineSpans(text: string): ChatSpan[] {
  const spans: ChatSpan[] = [];
  inline(text, true, false, spans);
  return spans;
}

export function render(value: unknown): ChatBlock[] {
  const text = String(value === undefined || value === null ? "" : value).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const output: ChatBlock[] = [];
  let paragraph: ChatSpan[][] = [];
  let code: string[] = [];
  let marker = "";
  let fenceLength = 0;
  const flush = () => {
    if (paragraph.length) output.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (marker) {
      const close = /^ {0,3}(\x60{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1].charAt(0) === marker && close[1].length >= fenceLength) {
        output.push({ kind: "code", text: code.join("") });
        code = [];
        marker = "";
      } else {
        code.push(line + (index < lines.length - 1 ? "\n" : ""));
      }
      continue;
    }
    const open = /^ {0,3}(\x60{3,}|~{3,})[^\n]*$/.exec(line);
    if (open || /^\s*$/.test(line)) {
      flush();
      if (open) {
        marker = open[1].charAt(0);
        fenceLength = open[1].length;
      }
    } else {
      paragraph.push(inlineSpans(line));
    }
  }
  if (marker) output.push({ kind: "code", text: code.join("") });
  flush();
  return output;
}

/** The blocks back as the plain text they show (copying, tests). */
export function plainText(blocks: ChatBlock[]): string {
  return blocks
    .map((b) => (b.kind === "code" ? b.text : b.lines.map((l) => l.map((s) => s.text).join("")).join("\n")))
    .join("\n\n");
}
