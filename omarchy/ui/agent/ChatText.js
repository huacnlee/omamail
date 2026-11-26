.pragma library

// This is a formatter, not an HTML sanitizer. Escape all source text first;
// only fixed, attribute-free formatting tags can enter the returned document.
function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function codeEnd(text, start) {
    var end = start;
    while (text.charAt(end) === "\x60") end++;
    var marker = text.slice(start, end);
    var close = text.indexOf(marker, end);
    return { start: end, end: close, after: close < 0 ? end : close + marker.length };
}

function boldEnd(text, start) {
    var index = start;
    while (index < text.length) {
        if (text.charAt(index) === "\x60") {
            var code = codeEnd(text, index);
            if (code) {
                index = code.after;
                continue;
            }
        }
        if (text.slice(index, index + 2) === "**") return index;
        index++;
    }
    return -1;
}

// Input is already escaped, including anything inside code spans. Code content
// is copied directly rather than passed through the emphasis formatter again.
function inlineText(text, allowBold) {
    var output = "";
    var index = 0;
    while (index < text.length) {
        if (text.charAt(index) === "\x60") {
            var code = codeEnd(text, index);
            if (code.end >= 0) {
                output += "<code>" + text.slice(code.start, code.end) + "</code>";
                index = code.after;
                continue;
            }
            output += text.slice(index, code.start);
            index = code.start;
            continue;
        }
        if (allowBold && text.slice(index, index + 2) === "**") {
            var close = boldEnd(text, index + 2);
            if (close > index + 2) {
                output += "<b>" + inlineText(text.slice(index + 2, close), false) + "</b>";
                index = close + 2;
                continue;
            }
        }
        output += text.charAt(index);
        index++;
    }
    return output;
}

function render(value) {
    var text = escapeHtml(String(value === undefined || value === null ? "" : value)
        .replace(/\r\n?/g, "\n"));
    var lines = text.split("\n");
    var output = [];
    var paragraph = [];
    var code = [];
    var marker = "";
    var fenceLength = 0;
    for (var index = 0; index < lines.length; index++) {
        var line = lines[index];
        if (marker) {
            var close = /^ {0,3}(\x60{3,}|~{3,})\s*$/.exec(line);
            if (close && close[1].charAt(0) === marker && close[1].length >= fenceLength) {
                output.push("<pre>" + code.join("") + "</pre>");
                code = [];
                marker = "";
            } else {
                code.push(line + (index < lines.length - 1 ? "\n" : ""));
            }
            continue;
        }
        var open = /^ {0,3}(\x60{3,}|~{3,})[^\n]*$/.exec(line);
        if (open || /^\s*$/.test(line)) {
            if (paragraph.length) output.push("<p>" + paragraph.join("<br>") + "</p>");
            paragraph = [];
            if (open) {
                marker = open[1].charAt(0);
                fenceLength = open[1].length;
            }
        } else {
            paragraph.push(inlineText(line, true));
        }
    }
    if (marker) output.push("<pre>" + code.join("") + "</pre>");
    if (paragraph.length) output.push("<p>" + paragraph.join("<br>") + "</p>");
    return output.join("");
}
