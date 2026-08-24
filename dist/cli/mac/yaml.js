/**
 * A strict YAML SUBSET parser and emitter for the monitoring-as-code
 * definition file (REA-246). Zero-dependency on purpose, same rule as the
 * rest of this CLI (REA-180): a `realuptime.yaml` is JSON-with-less-syntax
 * for this product, not a general YAML document, so this parses exactly the
 * YAML a definition file needs and REFUSES everything else with a line
 * number rather than guessing at it (the same "unsupported syntax is refused,
 * never ignored" rule the API's JSON-path grammar follows).
 *
 * Supported:
 *   - block mappings (`key: value`, `key:` + indented block)
 *   - block sequences (`- item`, `- key: value` starting an inline mapping)
 *   - flow sequences of scalars (`[iad, fra]`)
 *   - plain, "double-quoted" (JSON escapes), and 'single-quoted' scalars
 *   - `true`/`false`/`null`/`~`, JSON numbers, `#` comments, a leading `---`
 *
 * Refused (named error, never silently reinterpreted): tabs for indentation,
 * anchors/aliases (`&`, `*`), tags (`!`), block scalars (`|`, `>`), flow
 * mappings (`{}`), multi-document streams, duplicate keys, and anything the
 * grammar above doesn't describe. JSON is always accepted as-is by the
 * caller (`definition.ts`), so anything this subset can't express can be
 * written as JSON instead.
 */
export class YamlError extends Error {
    line;
    constructor(message, line) {
        super(`line ${line}: ${message}`);
        this.name = "YamlError";
        this.line = line;
    }
}
function stripComment(raw, no) {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inDouble) {
            if (ch === "\\")
                i++;
            else if (ch === '"')
                inDouble = false;
            continue;
        }
        if (inSingle) {
            if (ch === "'") {
                if (raw[i + 1] === "'")
                    i++;
                else
                    inSingle = false;
            }
            continue;
        }
        if (ch === '"')
            inDouble = true;
        else if (ch === "'")
            inSingle = true;
        else if (ch === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t"))
            return raw.slice(0, i).trimEnd();
    }
    if (inSingle || inDouble)
        throw new YamlError("Unterminated quoted string.", no);
    return raw.trimEnd();
}
function tokenize(source) {
    const lines = [];
    const rawLines = source.split(/\r?\n/);
    for (let i = 0; i < rawLines.length; i++) {
        const no = i + 1;
        const raw = rawLines[i];
        if (no === 1 && raw.trim() === "---")
            continue;
        if (raw.trim() === "---" || raw.trim() === "...") {
            throw new YamlError("Multi-document YAML streams are not supported; one definition per file.", no);
        }
        const text = stripComment(raw, no);
        if (text.trim().length === 0)
            continue;
        let indent = 0;
        while (text[indent] === " ")
            indent++;
        if (text[indent] === "\t")
            throw new YamlError("Tabs are not allowed for indentation; use spaces.", no);
        lines.push({ no, indent, text: text.slice(indent) });
    }
    return lines;
}
const PLAIN_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
function parseScalar(text, no) {
    const t = text.trim();
    if (t.length === 0)
        return null;
    if (t[0] === '"') {
        if (t[t.length - 1] !== '"' || t.length < 2)
            throw new YamlError("Unterminated double-quoted string.", no);
        try {
            return JSON.parse(t);
        }
        catch {
            throw new YamlError("Invalid escape in double-quoted string.", no);
        }
    }
    if (t[0] === "'") {
        if (t[t.length - 1] !== "'" || t.length < 2)
            throw new YamlError("Unterminated single-quoted string.", no);
        const inner = t.slice(1, -1);
        if (/(^|[^'])'([^']|$)/.test(inner))
            throw new YamlError("Unexpected quote inside single-quoted string.", no);
        return inner.replace(/''/g, "'");
    }
    if (t[0] === "[")
        return parseFlowSequence(t, no);
    if (t === "{}")
        return {};
    if (t[0] === "{")
        throw new YamlError("Flow mappings ({ }) are not supported; use an indented block.", no);
    if (t[0] === "&" || t[0] === "*")
        throw new YamlError("Anchors and aliases are not supported.", no);
    if (t[0] === "!")
        throw new YamlError("Tags are not supported.", no);
    if (t === "|" || t === ">" || /^[|>][-+]?\d*$/.test(t)) {
        throw new YamlError("Block scalars (| and >) are not supported; use a quoted string.", no);
    }
    if (t === "true")
        return true;
    if (t === "false")
        return false;
    if (t === "null" || t === "~")
        return null;
    if (PLAIN_NUMBER.test(t))
        return Number(t);
    return t;
}
function parseFlowSequence(text, no) {
    if (text[text.length - 1] !== "]")
        throw new YamlError("Unterminated flow sequence; expected ].", no);
    const inner = text.slice(1, -1).trim();
    if (inner.length === 0)
        return [];
    const items = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (quote) {
            current += ch;
            if (ch === "\\" && quote === '"')
                current += inner[++i] ?? "";
            else if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
        }
        else if (ch === "[" || ch === "{") {
            throw new YamlError("Nested flow collections are not supported.", no);
        }
        else if (ch === ",") {
            items.push(parseScalar(current, no));
            current = "";
        }
        else {
            current += ch;
        }
    }
    if (current.trim().length === 0)
        throw new YamlError("Trailing comma in flow sequence.", no);
    items.push(parseScalar(current, no));
    return items;
}
/** Splits `key: rest` at the first unquoted `: ` (or trailing `:`). Returns
 * null when the text is not a mapping entry. */
function splitKey(text, no) {
    let i = 0;
    if (text[0] === '"' || text[0] === "'") {
        const q = text[0];
        i = 1;
        while (i < text.length && text[i] !== q)
            i++;
        if (i >= text.length)
            throw new YamlError("Unterminated quoted key.", no);
        i++;
        const after = text.slice(i);
        if (!after.startsWith(":"))
            return null;
        const key = parseScalar(text.slice(0, i), no);
        return { key: String(key), rest: after.slice(1) };
    }
    for (; i < text.length; i++) {
        if (text[i] === ":" && (i === text.length - 1 || text[i + 1] === " ")) {
            const key = text.slice(0, i).trim();
            if (key.length === 0)
                throw new YamlError("Empty mapping key.", no);
            if (key.startsWith("[") || key.startsWith("{"))
                throw new YamlError("Collection keys are not supported.", no);
            return { key, rest: text.slice(i + 1) };
        }
    }
    return null;
}
class Parser {
    pos = 0;
    lines;
    constructor(lines) {
        this.lines = lines;
    }
    parseDocument() {
        if (this.lines.length === 0)
            return null;
        const value = this.parseBlock(this.lines[0].indent);
        if (this.pos < this.lines.length) {
            throw new YamlError("Unexpected content; check indentation.", this.lines[this.pos].no);
        }
        return value;
    }
    parseBlock(indent) {
        const line = this.lines[this.pos];
        if (line.text === "-" || line.text.startsWith("- "))
            return this.parseSequence(indent);
        if (splitKey(line.text, line.no))
            return this.parseMapping(indent);
        const value = parseScalar(line.text, line.no);
        this.pos++;
        return value;
    }
    parseMapping(indent) {
        const out = {};
        while (this.pos < this.lines.length) {
            const line = this.lines[this.pos];
            if (line.indent < indent)
                break;
            if (line.indent > indent)
                throw new YamlError("Unexpected indentation.", line.no);
            if (line.text === "-" || line.text.startsWith("- ")) {
                throw new YamlError("A sequence item cannot sit at the same level as a mapping key.", line.no);
            }
            const entry = splitKey(line.text, line.no);
            if (!entry)
                throw new YamlError(`Expected "key: value", got "${line.text}".`, line.no);
            if (Object.hasOwn(out, entry.key))
                throw new YamlError(`Duplicate key "${entry.key}".`, line.no);
            this.pos++;
            out[entry.key] = this.parseValueAfterKey(entry.rest, indent, line.no);
        }
        return out;
    }
    /** The value following `key:` -- inline on the same line, or the indented
     * block on the following lines. A sequence may sit at the SAME indent as
     * its key (`checks:\n- name: x`), which YAML allows and people write. */
    parseValueAfterKey(rest, parentIndent, no) {
        if (rest.trim().length > 0)
            return parseScalar(rest, no);
        const next = this.lines[this.pos];
        if (!next)
            return null;
        if (next.indent > parentIndent)
            return this.parseBlock(next.indent);
        if (next.indent === parentIndent && (next.text === "-" || next.text.startsWith("- "))) {
            return this.parseSequence(parentIndent);
        }
        return null;
    }
    parseSequence(indent) {
        const out = [];
        while (this.pos < this.lines.length) {
            const line = this.lines[this.pos];
            if (line.indent < indent)
                break;
            if (line.indent > indent)
                throw new YamlError("Unexpected indentation.", line.no);
            if (!(line.text === "-" || line.text.startsWith("- ")))
                break;
            const rest = line.text.slice(1).trimStart();
            const itemIndent = indent + (line.text.length - rest.length);
            if (rest.length === 0) {
                this.pos++;
                const next = this.lines[this.pos];
                out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
                continue;
            }
            if (rest.startsWith("- ") || rest === "-") {
                throw new YamlError("Nested inline sequences (- - x) are not supported.", line.no);
            }
            const entry = splitKey(rest, line.no);
            if (entry) {
                // Rewrite the line as the first key of an inline mapping indented at
                // the item's column, then let parseMapping consume it and its siblings.
                this.lines[this.pos] = { no: line.no, indent: itemIndent, text: rest };
                out.push(this.parseMapping(itemIndent));
                continue;
            }
            out.push(parseScalar(rest, line.no));
            this.pos++;
        }
        return out;
    }
}
export function parseYaml(source) {
    return new Parser(tokenize(source)).parseDocument();
}
const PLAIN_SAFE = /^[A-Za-z_][A-Za-z0-9_./:@+-]*$/;
function emitScalar(value) {
    if (value === null)
        return "null";
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (value.length > 0 && PLAIN_SAFE.test(value) && !["true", "false", "null", "~"].includes(value) && !PLAIN_NUMBER.test(value)) {
        return value;
    }
    return JSON.stringify(value);
}
/** Emits a value in the same subset `parseYaml` reads, so
 * `parseYaml(stringifyYaml(x))` deep-equals `x` for any JSON value made of
 * objects, arrays, and scalars (the `export` command's round-trip promise). */
export function stringifyYaml(value, indent = 0) {
    const pad = " ".repeat(indent);
    if (Array.isArray(value)) {
        if (value.length === 0)
            return `${pad}[]`;
        if (value.every((item) => item === null || typeof item !== "object")) {
            const scalars = value;
            return `${pad}[${scalars.map(emitScalar).join(", ")}]`;
        }
        return value
            .map((item) => {
            if (item !== null && typeof item === "object" && !Array.isArray(item)) {
                const body = stringifyYaml(item, indent + 2);
                return `${pad}- ${body.trimStart()}`;
            }
            if (Array.isArray(item))
                return `${pad}-\n${stringifyYaml(item, indent + 2)}`;
            return `${pad}- ${emitScalar(item)}`;
        })
            .join("\n");
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 0)
            return `${pad}{}`;
        return entries
            .map(([key, item]) => {
            const k = PLAIN_SAFE.test(key) ? key : JSON.stringify(key);
            if (item !== null && typeof item === "object") {
                if (Array.isArray(item) && item.every((x) => x === null || typeof x !== "object")) {
                    return `${pad}${k}: ${stringifyYaml(item, 0)}`;
                }
                if ((Array.isArray(item) && item.length === 0) || (!Array.isArray(item) && Object.keys(item).length === 0)) {
                    return `${pad}${k}: ${Array.isArray(item) ? "[]" : "{}"}`;
                }
                return `${pad}${k}:\n${stringifyYaml(item, indent + 2)}`;
            }
            return `${pad}${k}: ${emitScalar(item)}`;
        })
            .join("\n");
    }
    return `${pad}${emitScalar(value)}`;
}
