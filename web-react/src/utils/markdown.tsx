import React from 'react'

// A report, drawn as a document. The Worker's reports are Markdown written by
// a model from material other people wrote, so none of it is trusted: this
// reads the few shapes a report uses — headings, lists, bold, italic, code,
// links — into React elements, and everything else stays text. No HTML ever
// reaches the page, and a link goes nowhere but http(s).

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }

export type Block =
  | { kind: 'heading'; level: 2 | 3; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'paragraph'; children: Inline[] }

/// The address, if it is one a report may link to: absolute, and http or
/// https. `javascript:`, `data:` and relative paths come back null.
export function safeHref(raw: string): string | null {
  const text = raw.trim()
  if (!/^https?:\/\//i.test(text)) return null
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/// Where the address that starts at `from` ends: the `)` that balances,
/// so a Wikipedia link with parentheses in it stays one link.
function closingParen(source: string, from: number): number {
  let depth = 0
  for (let j = from; j < source.length; j++) {
    if (source[j] === '(') depth += 1
    else if (source[j] === ')') { if (depth === 0) return j; depth -= 1 }
  }
  return -1
}

/// One line's worth of emphasis, code and links. Anything that does not
/// close is left as the characters it was.
export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  const push = (text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === 'text') last.text += text
    else out.push({ kind: 'text', text })
  }
  let i = 0
  let plain = ''
  const flush = () => { push(plain); plain = '' }
  while (i < source.length) {
    const ch = source[i]
    if (ch === '`') {
      const end = source.indexOf('`', i + 1)
      if (end > i + 1) { flush(); out.push({ kind: 'code', text: source.slice(i + 1, end) }); i = end + 1; continue }
    } else if (ch === '*' && source[i + 1] === '*') {
      const end = source.indexOf('**', i + 2)
      if (end > i + 2 && source[i + 2] !== ' ') {
        flush(); out.push({ kind: 'strong', children: parseInline(source.slice(i + 2, end)) }); i = end + 2; continue
      }
    } else if (ch === '*' && source[i + 1] && source[i + 1] !== ' ' && source[i + 1] !== '*') {
      // A lone asterisk before a space is a multiplication or a footnote,
      // not emphasis; so is one whose partner follows a space.
      let end = source.indexOf('*', i + 1)
      while (end > 0 && (source[end - 1] === ' ' || source[end + 1] === '*')) end = source.indexOf('*', end + (source[end + 1] === '*' ? 2 : 1))
      if (end > i + 1) { flush(); out.push({ kind: 'em', children: parseInline(source.slice(i + 1, end)) }); i = end + 1; continue }
    } else if (ch === '[') {
      const close = source.indexOf('](', i + 1)
      const paren = close > i ? closingParen(source, close + 2) : -1
      if (close > i && paren > close) {
        const label = source.slice(i + 1, close)
        const href = safeHref(source.slice(close + 2, paren))
        flush()
        // A link to somewhere a report may not send you keeps its words.
        if (href) out.push({ kind: 'link', href, children: parseInline(label) })
        else push(label)
        i = paren + 1
        continue
      }
    }
    plain += ch
    i += 1
  }
  flush()
  return out
}

const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/

/// The document's blocks. A blank line ends a paragraph or a list; a line
/// indented under a list item continues it.
export function parseBlocks(source: string): Block[] {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  let list: { ordered: boolean; start: number; items: string[] } | null = null
  const endPara = () => {
    if (para.length) blocks.push({ kind: 'paragraph', children: parseInline(para.join('\n')) })
    para = []
  }
  const endList = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, start: list.start, items: list.items.map(parseInline) })
    list = null
  }
  for (const line of lines) {
    if (!line.trim()) { endPara(); endList(); continue }
    const heading = line.match(HEADING)
    if (heading) {
      endPara(); endList()
      blocks.push({ kind: 'heading', level: heading[1].length <= 2 ? 2 : 3, children: parseInline(heading[2]) })
      continue
    }
    const bullet = line.match(BULLET)
    const numbered = bullet ? null : line.match(NUMBERED)
    if (bullet || numbered) {
      endPara()
      const ordered = Boolean(numbered)
      if (list && list.ordered !== ordered) endList()
      if (!list) list = { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] }
      list.items.push((bullet ? bullet[1] : numbered![2]).trim())
      continue
    }
    if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    endList()
    para.push(line.trim())
  }
  endPara(); endList()
  return blocks
}

function renderInline(nodes: Inline[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text': return <React.Fragment key={i}>{node.text}</React.Fragment>
      case 'strong': return <strong key={i}>{renderInline(node.children)}</strong>
      case 'em': return <em key={i}>{renderInline(node.children)}</em>
      case 'code': return <code key={i}>{node.text}</code>
      case 'link': return <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">{renderInline(node.children)}</a>
    }
  })
}

/// The document itself. `className` sits on the wrapper; the elements inside
/// are plain h2, h3, p, ul, ol, so the stylesheet decides how they read.
export const Markdown: React.FC<{ source: string; className?: string }> = ({ source, className }) => (
  <div className={className}>
    {parseBlocks(source).map((block, i) => {
      if (block.kind === 'heading') {
        return block.level === 2
          ? <h2 key={i}>{renderInline(block.children)}</h2>
          : <h3 key={i}>{renderInline(block.children)}</h3>
      }
      if (block.kind === 'list') {
        const items = block.items.map((item, j) => <li key={j}>{renderInline(item)}</li>)
        return block.ordered
          ? <ol key={i} start={block.start === 1 ? undefined : block.start}>{items}</ol>
          : <ul key={i}>{items}</ul>
      }
      return <p key={i}>{renderInline(block.children)}</p>
    })}
  </div>
)
