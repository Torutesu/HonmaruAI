#!/usr/bin/env node
// Every string the app draws must be in the catalogue.
//
// SwiftUI makes this easy to get wrong in one specific way: `Text("Save")` is a
// localisation key and `Text(someString)` is not — the second renders the
// variable verbatim, in whatever language it happens to be, with no warning and
// no entry in the catalogue. Fifteen strings had drifted out that way, so a
// Japanese phone showed English in the middle of otherwise translated screens.
//
// This finds literals passed to Text/String(localized:)/LocalizedStringKey that
// the catalogue does not know about. It cannot see `Text(variable)` — nothing
// static can — but it does catch every new literal the moment it is added.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "TikTokForWork", "Localizable.xcstrings");
const known = new Set(Object.keys(JSON.parse(readFileSync(catalogPath, "utf8")).strings));

const LITERAL = /(?:String\(localized:\s*|Text\(|LocalizedStringKey\()"((?:[^"\\]|\\.)*)"/g;
// Comments quote example code — `Text("key")` in a doc comment is not a string
// the app draws.
const COMMENT = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
const INTERPOLATION = /\\\([^()]*(?:\([^()]*\)[^()]*)*\)/g;

// The same literal is stored with %@ or %lld depending on what was
// interpolated, and the source does not say which. Accept either.
function spellings(literal) {
  const parts = literal.split(INTERPOLATION);
  const holes = parts.length - 1;
  if (holes === 0) return [literal];
  const out = [];
  for (let bits = 0; bits < 1 << holes; bits += 1) {
    let s = parts[0];
    for (let i = 0; i < holes; i += 1) s += ((bits >> i) & 1 ? "%lld" : "%@") + parts[i + 1];
    out.push(s);
  }
  return out;
}

// Text("·") is punctuation, not a sentence. A literal with no letter in it has
// nothing to translate.
const hasLetters = (s) => /[A-Za-z぀-ヿ一-龯]/.test(s.replace(INTERPOLATION, ""));

function swiftFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...swiftFiles(path));
    else if (entry.endsWith(".swift")) out.push(path);
  }
  return out;
}

const missing = new Map();
for (const file of swiftFiles(join(root, "TikTokForWork"))) {
  const source = readFileSync(file, "utf8").replace(COMMENT, "");
  for (const match of source.matchAll(LITERAL)) {
    const literal = match[1];
    // The catalogue stores the string, not its Swift escaping.
    const key = literal
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    if (!key.trim() || !hasLetters(key)) continue;
    if (spellings(key).some((s) => known.has(s))) continue;
    const line = source.slice(0, match.index).split("\n").length;
    missing.set(key, `${file.replace(`${root}/`, "")}:${line}`);
  }
}

if (missing.size === 0) {
  console.log(`Localization: every drawn literal is in the catalogue (${known.size} keys).`);
  process.exit(0);
}

console.error(`Localization: ${missing.size} literal(s) not in Localizable.xcstrings.\n`);
for (const [literal, where] of missing) console.error(`  ${where}\n    ${JSON.stringify(literal)}`);
console.error("\nAdd each to TikTokForWork/Localizable.xcstrings with a ja translation.");
process.exit(1);
