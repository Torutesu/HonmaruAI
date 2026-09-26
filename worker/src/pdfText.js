// The words in a PDF, for the workspace's data rules (dlpFiles.js). Not a
// renderer: it finds the pages, their content streams and the fonts they
// name, and reads the text-showing operators, turning each font's codes into
// characters through the font's ToUnicode map when it has one. Enough for
// what office software and browsers print to PDF; a scanned page is a
// picture, and has no words here.
//
// A PDF is compressed streams inside a file of any size: every stream is
// inflated with a cap, and all of them together with another, so a small
// file cannot become a large one. An encrypted PDF is not read.

const MAX_STREAM_INFLATED = 8 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 24 * 1024 * 1024;
const MAX_TEXT_OUT = 1024 * 1024;
const MAX_FORM_DEPTH = 3;

const WHITE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([...Array.from("()<>[]{}/%", (c) => c.charCodeAt(0))]);

export function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

// ---- Reading PDF syntax ----

class Lexer {
  constructor(src, pos = 0) { this.src = src; this.pos = pos; }

  skip() {
    const s = this.src;
    for (;;) {
      while (this.pos < s.length && WHITE.has(s.charCodeAt(this.pos))) this.pos++;
      if (s[this.pos] !== "%") return;
      while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++;
    }
  }

  regular() {
    const s = this.src;
    const start = this.pos;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WHITE.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    return s.slice(start, this.pos);
  }

  literal() {
    const s = this.src;
    let depth = 1;
    let out = "";
    this.pos++;
    while (this.pos < s.length) {
      const c = s[this.pos++];
      if (c === "\\") {
        const e = s[this.pos++];
        if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "\r") { if (s[this.pos] === "\n") this.pos++; }
        else if (e === "\n") { /* a line continued */ }
        else if (e >= "0" && e <= "7") {
          let oct = e;
          while (oct.length < 3 && s[this.pos] >= "0" && s[this.pos] <= "7") oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (e !== undefined) out += e;
      } else if (c === "(") { depth++; out += c; }
      else if (c === ")") { if (--depth === 0) break; out += c; }
      else out += c;
    }
    return out;
  }

  hex() {
    const s = this.src;
    const end = s.indexOf(">", this.pos);
    const digits = s.slice(this.pos + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, "");
    this.pos = end < 0 ? s.length : end + 1;
    let out = "";
    for (let i = 0; i < digits.length; i += 2) out += String.fromCharCode(parseInt((digits[i] + (digits[i + 1] || "0")), 16));
    return { str: out, hex: digits };
  }

  /// The next token: { t: "num"|"name"|"str"|"kw"|"<<"|">>"|"["|"]"|"{"|"}"|"eof", v }.
  next() {
    for (;;) {
      const tok = this.one();
      if (tok) return tok;
    }
  }

  /// One token, or null for a stray character skipped.
  one() {
    this.skip();
    const s = this.src;
    if (this.pos >= s.length) return { t: "eof" };
    const c = s[this.pos];
    if (c === "<" && s[this.pos + 1] === "<") { this.pos += 2; return { t: "<<" }; }
    if (c === ">" && s[this.pos + 1] === ">") { this.pos += 2; return { t: ">>" }; }
    if (c === "[" || c === "]" || c === "{" || c === "}") { this.pos++; return { t: c }; }
    if (c === "(") return { t: "str", v: this.literal() };
    if (c === "<") { const h = this.hex(); return { t: "str", v: h.str, hex: h.hex }; }
    if (c === ">" || c === ")") { this.pos++; return null; }
    if (c === "/") {
      this.pos++;
      return { t: "name", v: this.regular().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    const word = this.regular();
    if (!word) { this.pos++; return null; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: "num", v: Number(word) };
    return { t: "kw", v: word };
  }
}

const isRef = (v) => v && typeof v === "object" && "ref" in v;

/// One value at the lexer: numbers, names, strings, arrays, dictionaries,
/// and `n g R` references as { ref: n }.
function parseValue(lex, tok = lex.next(), depth = 0) {
  if (depth > 64) return null;
  if (tok.t === "num") {
    const save = lex.pos;
    const a = lex.next();
    if (a.t === "num") {
      const b = lex.next();
      if (b.t === "kw" && b.v === "R") return { ref: tok.v };
    }
    lex.pos = save;
    return tok.v;
  }
  if (tok.t === "name" || tok.t === "str") return tok.t === "name" ? { name: tok.v } : tok.v;
  if (tok.t === "[") {
    const out = [];
    for (;;) {
      const t = lex.next();
      if (t.t === "]" || t.t === "eof") return out;
      out.push(parseValue(lex, t, depth + 1));
    }
  }
  if (tok.t === "<<") {
    const out = {};
    for (;;) {
      const k = lex.next();
      if (k.t === ">>" || k.t === "eof") return out;
      if (k.t !== "name") continue;
      out[k.v] = parseValue(lex, lex.next(), depth + 1);
    }
  }
  if (tok.t === "kw") {
    if (tok.v === "true") return true;
    if (tok.v === "false") return false;
    return null;
  }
  return null;
}

const nameOf = (v) => (v && typeof v === "object" && "name" in v ? v.name : null);

// ---- Streams ----

async function inflateLoose(bytes, cap) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) { await reader.cancel().catch(() => {}); throw new RangeError("A stream inflates past the limit."); }
      parts.push(value);
    }
  } catch (err) {
    // A stream cut short still says what it said before the cut.
    if (err instanceof RangeError) throw err;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

class Pdf {
  constructor(bytes) {
    this.bytes = bytes;
    this.src = latin1(bytes);
    this.objects = new Map(); // num -> { dict|value, start, end } | { value }
    this.inflated = 0;
    this.decoded = new Map();
    this.cmaps = new Map();
  }

  index() {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(this.src))) {
      const lex = new Lexer(this.src, m.index + m[0].length);
      const value = parseValue(lex);
      const entry = { value };
      const save = lex.pos;
      const kw = lex.next();
      if (kw.t === "kw" && kw.v === "stream") {
        let start = lex.pos;
        if (this.src[start] === "\r") start++;
        if (this.src[start] === "\n") start++;
        let end = this.src.indexOf("endstream", start);
        if (end < 0) end = this.src.length;
        let trim = end;
        if (this.src[trim - 1] === "\n") trim--;
        if (this.src[trim - 1] === "\r") trim--;
        entry.start = start;
        entry.end = Math.max(start, trim);
        re.lastIndex = end;
      } else {
        lex.pos = save;
        re.lastIndex = Math.max(re.lastIndex, lex.pos);
      }
      this.objects.set(Number(m[1]), entry);
    }
  }

  get(v, hops = 0) {
    while (isRef(v) && hops++ < 32) v = this.objects.get(v.ref)?.value;
    return v ?? null;
  }

  /// A stream's bytes, its filters undone; null for filters that are not
  /// text (images) or not handled.
  async stream(num) {
    if (this.decoded.has(num)) return this.decoded.get(num);
    const entry = this.objects.get(num);
    let out = null;
    if (entry && entry.start !== undefined && entry.value && typeof entry.value === "object") {
      const raw = this.bytes.subarray(entry.start, entry.end);
      const f = this.get(entry.value.Filter);
      const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => nameOf(this.get(x)));
      if (!filters.length) out = raw;
      else if (filters.length === 1 && (filters[0] === "FlateDecode" || filters[0] === "Fl")) {
        const left = MAX_TOTAL_INFLATED - this.inflated;
        if (left > 0) {
          try {
            out = await inflateLoose(raw, Math.min(MAX_STREAM_INFLATED, left));
            this.inflated += out.byteLength;
          } catch { out = null; }
        }
      }
    }
    this.decoded.set(num, out);
    return out;
  }

  /// Objects kept inside object streams, which newer PDFs put fonts and
  /// pages in. Ones already found at the top level are left as they are.
  async unpackObjectStreams() {
    for (const [num, entry] of [...this.objects]) {
      if (nameOf(entry.value?.Type) !== "ObjStm") continue;
      const data = await this.stream(num);
      if (!data) continue;
      const src = latin1(data);
      const n = Number(this.get(entry.value.N)) || 0;
      const first = Number(this.get(entry.value.First)) || 0;
      const head = new Lexer(src);
      const pairs = [];
      for (let i = 0; i < n && i < 100_000; i++) {
        const a = head.next(); const b = head.next();
        if (a.t !== "num" || b.t !== "num") break;
        pairs.push([a.v, b.v]);
      }
      for (const [objNum, offset] of pairs) {
        if (this.objects.has(objNum)) continue;
        this.objects.set(objNum, { value: parseValue(new Lexer(src, first + offset)) });
      }
    }
  }

  encrypted() {
    for (const m of this.src.matchAll(/trailer\s*<</g)) {
      const trailer = parseValue(new Lexer(this.src, m.index + m[0].length - 2));
      if (trailer?.Encrypt) return true;
    }
    for (const entry of this.objects.values()) {
      if (nameOf(entry.value?.Type) === "XRef" && entry.value.Encrypt) return true;
    }
    return false;
  }

  // ---- Fonts ----

  async cmapOf(font) {
    const ref = font?.ToUnicode;
    if (!isRef(ref)) return null;
    if (this.cmaps.has(ref.ref)) return this.cmaps.get(ref.ref);
    const data = await this.stream(ref.ref);
    const cmap = data ? parseCMap(latin1(data)) : null;
    this.cmaps.set(ref.ref, cmap);
    return cmap;
  }

  async fontsOf(resources) {
    const fonts = new Map();
    const dict = this.get(this.get(resources)?.Font);
    if (!dict || typeof dict !== "object") return fonts;
    for (const [name, ref] of Object.entries(dict)) {
      const font = this.get(ref);
      if (!font || typeof font !== "object") continue;
      const cmap = await this.cmapOf(font);
      const encoding = nameOf(this.get(font.Encoding));
      fonts.set(name, { cmap, twoByte: nameOf(this.get(font.Subtype)) === "Type0" || /^Identity-/.test(encoding || "") });
    }
    return fonts;
  }

  resourcesOf(page) {
    let node = page;
    for (let hops = 0; node && hops < 32; hops++) {
      if (node.Resources) return this.get(node.Resources);
      node = this.get(node.Parent);
    }
    return null;
  }

  // ---- Pages ----

  async contentOf(value) {
    const v = isRef(value) ? this.get(value) : value;
    const refs = Array.isArray(v) ? v : [value];
    const parts = [];
    for (const r of refs) {
      if (!isRef(r)) continue;
      const data = await this.stream(r.ref);
      if (data) parts.push(latin1(data));
    }
    return parts.join("\n");
  }

  async textOf(content, resources, out, depth = 0) {
    const fonts = await this.fontsOf(resources);
    const xobjects = this.get(this.get(resources)?.XObject) || {};
    const lex = new Lexer(content);
    const stack = [];
    let font = null;
    const show = (s) => { out.push(decodeShown(s, font)); };
    for (;;) {
      if (out.size > MAX_TEXT_OUT) return;
      const tok = lex.next();
      if (tok.t === "eof") return;
      if (tok.t !== "kw") {
        stack.push(tok.t === "[" || tok.t === "<<" ? parseValue(lex, tok) : tok);
        if (stack.length > 64) stack.shift();
        continue;
      }
      const op = tok.v;
      const top = stack[stack.length - 1];
      if (op === "Tf") {
        const name = stack[stack.length - 2];
        font = name?.t === "name" ? fonts.get(name.v) || null : null;
      } else if (op === "Tj") {
        if (top?.t === "str") show(top);
      } else if (op === "'" || op === "\"") {
        out.push("\n");
        if (top?.t === "str") show(top);
      } else if (op === "TJ") {
        if (Array.isArray(top)) {
          for (const part of top) {
            if (typeof part === "string") show({ v: part });
            else if (typeof part === "number" && part < -200) out.push(" ");
          }
        }
      } else if (op === "Td" || op === "TD") {
        out.push(stack[stack.length - 1]?.v ? "\n" : " ");
      } else if (op === "T*" || op === "Tm" || op === "ET") {
        out.push("\n");
      } else if (op === "Do" && depth < MAX_FORM_DEPTH) {
        const name = top?.t === "name" ? top.v : null;
        const ref = name ? xobjects[name] : null;
        const form = isRef(ref) ? this.objects.get(ref.ref) : null;
        if (form && nameOf(form.value?.Subtype) === "Form") {
          const data = await this.stream(ref.ref);
          if (data) await this.textOf(latin1(data), form.value.Resources || resources, out, depth + 1);
        }
      } else if (op === "ID") {
        // An inline image's bytes, up to its end.
        const end = content.slice(lex.pos).search(/\sEI(\s|$)/);
        lex.pos = end < 0 ? content.length : lex.pos + end + 3;
      }
      stack.length = 0;
    }
  }

  async text() {
    const out = { parts: [], size: 0, push(s) { if (!s) return; this.parts.push(s); this.size += s.length; } };
    const pages = [...this.objects.values()].filter((e) => nameOf(e.value?.Type) === "Page");
    for (const page of pages) {
      if (out.size > MAX_TEXT_OUT) break;
      const content = await this.contentOf(page.value.Contents);
      if (content) await this.textOf(content, this.resourcesOf(page.value), out);
      out.push("\n");
    }
    return out.parts.join("").replace(/[ \t]+\n/g, "\n").slice(0, MAX_TEXT_OUT);
  }
}

// ---- Codes to characters ----

function utf16(hex) {
  let s = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16));
  return s;
}

/// A ToUnicode CMap: how many bytes a code is, and what each code says.
export function parseCMap(src) {
  const map = new Map();
  let bytes = 0;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(src);
  if (space) {
    const first = /<([0-9a-fA-F]+)>/.exec(space[1]);
    if (first) bytes = Math.ceil(first[1].length / 2);
  }
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1], 16), utf16(m[2]));
      if (!bytes) bytes = Math.ceil(m[1].length / 2);
    }
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 0xffff);
      if (!bytes) bytes = Math.ceil(m[1].length / 2);
      if (m[3].startsWith("[")) {
        const list = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      } else {
        const base = utf16(m[3].slice(1, -1));
        if (!base) continue;
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return map.size ? { bytes: bytes || 1, map } : null;
}

function decodeShown(tok, font) {
  const s = tok.v || "";
  if (font?.cmap) {
    const { bytes, map } = font.cmap;
    let out = "";
    for (let i = 0; i + bytes <= s.length; i += bytes) {
      let code = 0;
      for (let j = 0; j < bytes; j++) code = (code << 8) | s.charCodeAt(i + j);
      out += map.get(code) ?? "";
    }
    return out;
  }
  // Glyph numbers with nothing to say what they are: no words to read.
  if (font?.twoByte) return "";
  return s;
}

/// The text of a PDF's bytes, or null when it is not a PDF we can read.
export async function pdfText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (latin1(bytes.subarray(0, 1024)).indexOf("%PDF-") < 0) return null;
  const pdf = new Pdf(bytes);
  pdf.index();
  await pdf.unpackObjectStreams();
  if (pdf.encrypted()) return null;
  return pdf.text();
}
