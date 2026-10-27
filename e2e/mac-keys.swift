// Real keystrokes on a Mac, through whatever input method is selected — the
// way a person types, not events handed to the page. Used by
// e2e/desktop-ime.mjs to type Japanese into the Mac app with Apple's own IME.
//
//   swift e2e/mac-keys.swift status
//   swift e2e/mac-keys.swift japanese          # select Japanese – Romaji
//   swift e2e/mac-keys.swift activate <pid>    # bring that app to the front
//   swift e2e/mac-keys.swift type <ms> <keys>  # n i h o n g o, ␣ space, ⏎ return
import AppKit
import Carbon

func say(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
func fail(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }

func sources(all: Bool) -> [TISInputSource] {
  (TISCreateInputSourceList(nil, all)?.takeRetainedValue() as? [TISInputSource]) ?? []
}
func id(_ s: TISInputSource) -> String {
  guard let p = TISGetInputSourceProperty(s, kTISPropertyInputSourceID) else { return "?" }
  return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
}
func current() -> String { id(TISCopyCurrentKeyboardInputSource().takeRetainedValue()) }

// US ANSI virtual key codes: the romaji is typed on the keys, and the input
// method turns it into kana.
let codes: [Character: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
  "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35,
  "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "-": 27, ".": 47, ",": 43, "␣": 49, "⏎": 36,
]

let args = CommandLine.arguments.dropFirst()
switch args.first {
case "status":
  say("trusted=\(AXIsProcessTrusted()) source=\(current())")
case "japanese":
  let wanted = ["com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese", "com.apple.inputmethod.Kotoeri.Japanese"]
  if wanted.contains(current()) { say("source=\(current())"); exit(0) }
  // A mode (…RomajiTyping.Japanese) cannot be selected until the input
  // method it belongs to (…RomajiTyping) is enabled, and what is newly
  // enabled only shows up in a list read afterwards.
  let kotoeri = sources(all: true).filter { id($0).hasPrefix("com.apple.inputmethod.Kotoeri.RomajiTyping") || wanted.contains(id($0)) }
  if kotoeri.isEmpty { fail("no Japanese input method installed: \(sources(all: true).map(id).filter { $0.contains("inputmethod") })") }
  for s in kotoeri.sorted(by: { id($0).count < id($1).count }) { _ = TISEnableInputSource(s) }
  var last: OSStatus = noErr
  for _ in 0..<30 where !wanted.contains(current()) {
    usleep(200_000)
    if let mode = sources(all: false).first(where: { wanted.contains(id($0)) }) { last = TISSelectInputSource(mode) }
  }
  say("source=\(current())")
  if !wanted.contains(current()) {
    fail("could not select Japanese (last status \(last)); enabled: \(sources(all: false).map(id)); installed Kotoeri: \(kotoeri.map(id))")
  }
case "activate":
  guard let raw = args.dropFirst().first, let pid = pid_t(raw), let app = NSRunningApplication(processIdentifier: pid) else { fail("no app with that pid") }
  app.activate(options: [.activateAllWindows])
  for _ in 0..<50 where NSWorkspace.shared.frontmostApplication?.processIdentifier != pid { usleep(100_000) }
  say("frontmost=\(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)")
case "type":
  let rest = Array(args.dropFirst())
  guard rest.count == 2, let ms = UInt32(rest[0]) else { fail("type <ms> <keys>") }
  let source = CGEventSource(stateID: .hidSystemState)
  for ch in rest[1] {
    guard let code = codes[ch] else { fail("no key for \(ch)") }
    CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    usleep(12_000)
    CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
    usleep(ms * 1000)
  }
  say("typed \(rest[1].count) keys")
default:
  fail("status | japanese | activate <pid> | type <ms> <keys>")
}
