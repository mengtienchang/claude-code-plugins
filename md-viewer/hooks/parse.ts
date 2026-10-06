/**
 * Markdown → 窗格要畫的段落。純函數，不碰檔案系統。
 *
 * 窗格的 Markdown 元件一個最多 10000 字、只認 http/https/file 連結、不認 HTML，
 * 所以這裡把文件切成段，順手把畫不出來的語法換成畫得出來的：
 * mermaid 與內嵌 <svg> 拆成獨立的圖段，VitePress 的 ::: 容器、<details>、
 * 帶 label 的元件轉成引用區塊，相對連結轉成 file:// 絕對網址。
 */

export type MdSegment = {
  kind: 'md'
  text: string
  /** 這段裡點了要在窗格內跳轉的連結（指向 md 的 file:// 網址，含錨點） */
  links: string[]
}

export type Segment =
  | MdSegment
  | { kind: 'svg'; source: string; alt: string }
  | { kind: 'mermaid'; code: string; hash: string }
  | { kind: 'frontmatter'; source: string }
  | { kind: 'note'; text: string }

export type Heading = {
  level: number
  text: string
  slug: string
  /** 標題落在第幾段 */
  segment: number
}

export type Doc = {
  title: string
  segments: Segment[]
  headings: Heading[]
  /** 每一頁第一段的索引，第一頁永遠是 0 */
  pages: number[]
}

/** Markdown 元件上限 10000 字，留點餘裕給引用前綴 */
export const CHUNK_LIMIT = 8000
/** 一頁累積到這麼多字，遇到 h1/h2 就換頁 */
export const PAGE_SOFT = 25000
/** 一頁再多就硬換頁，免得整棵樹超過畫面的上限 */
export const PAGE_HARD = 45000
/** mermaid 畫出來前不知道多大，分頁時先當這麼重 */
const MERMAID_WEIGHT = 15000
/** Markdown 元件的 pressableLinks 最多 256 條 */
const LINKS_LIMIT = 256
/** mermaid 的渲染設定改了就換這個值，舊的快取自然失效 */
export const MERMAID_SALT = 'mdv-mermaid-2:'

const CONTAINERS: Record<string, { icon: string; label: string }> = {
  info: { icon: 'ℹ️', label: '說明' },
  tip: { icon: '💡', label: '提示' },
  warning: { icon: '⚠️', label: '注意' },
  danger: { icon: '🛑', label: '危險' },
  caution: { icon: '🛑', label: '小心' },
  note: { icon: '📝', label: '備註' },
  important: { icon: '❗', label: '重要' },
  details: { icon: '▸', label: '詳細' },
}

// ---------------------------------------------------------------- 路徑與連結

export function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 收掉 `.`、`..` 與重複的斜線 */
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return (isAbsolute ? '/' : '') + parts.join('/')
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

export function toFileUrl(absolute: string): string {
  return 'file://' + absolute.split('/').map(encodeURIComponent).join('/')
}

export function fromFileUrl(href: string): { path: string; hash: string } | undefined {
  if (!href.startsWith('file://')) return undefined
  const rest = href.slice('file://'.length)
  const cut = rest.indexOf('#')
  const path = safeDecode(cut < 0 ? rest : rest.slice(0, cut))
  const hash = cut < 0 ? '' : safeDecode(rest.slice(cut + 1))
  return { path, hash }
}

/**
 * 文件裡寫的連結 → 窗格畫得出來的網址。
 * 錨點與相對路徑轉成 file:// 絕對網址；站內絕對路徑（/api/...）與其他 scheme 原樣留著。
 */
export function resolveHref(raw: string, file: string): { href: string; isPressable: boolean } {
  const href = raw.trim()
  if (href === '') return { href: raw, isPressable: false }
  if (href.startsWith('#')) {
    return { href: `${toFileUrl(file)}#${encodeURIComponent(safeDecode(href.slice(1)))}`, isPressable: true }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return { href, isPressable: false }
  const cut = href.indexOf('#')
  const pathPart = cut < 0 ? href : href.slice(0, cut)
  const hash = cut < 0 ? '' : href.slice(cut + 1)
  const absolute = normalizePath(`${dirname(file)}/${safeDecode(pathPart)}`)
  const url = toFileUrl(absolute) + (hash ? `#${encodeURIComponent(safeDecode(hash))}` : '')
  return { href: url, isPressable: isMarkdownPath(absolute) }
}

// ---------------------------------------------------------------- 標題

const rControl = /[\u0000-\u001f]/g
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g
const rCombining = /[̀-ͯ]/g

/** 跟 VitePress（@mdit-vue/shared）同一套 slug，文件裡的 #錨點 才對得上 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(rCombining, '')
    .replace(rControl, '')
    .replace(rSpecial, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
}

/** 標題的純文字：拿掉連結語法、HTML、反引號與粗斜體記號（底線留著，snake_case 常見） */
export function plainText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\*/g, '')
    .trim()
}

// ---------------------------------------------------------------- 行內轉換

/** 依反引號切出行內 code（成對、同長度），code 裡的東西不轉 */
export function splitCodeSpans(line: string): { text: string; isCode: boolean }[] {
  const parts: { text: string; isCode: boolean }[] = []
  let at = 0
  let last = 0
  while (at < line.length) {
    if (line[at] !== '`') {
      at++
      continue
    }
    let runEnd = at
    while (runEnd < line.length && line[runEnd] === '`') runEnd++
    const size = runEnd - at
    let scan = runEnd
    let close = -1
    while (scan < line.length) {
      if (line[scan] !== '`') {
        scan++
        continue
      }
      let end = scan
      while (end < line.length && line[end] === '`') end++
      if (end - scan === size) {
        close = end
        break
      }
      scan = end
    }
    if (close < 0) {
      at = runEnd
      continue
    }
    if (at > last) parts.push({ text: line.slice(last, at), isCode: false })
    parts.push({ text: line.slice(at, close), isCode: true })
    at = last = close
  }
  if (last < line.length) parts.push({ text: line.slice(last), isCode: false })
  return parts
}

function transformText(text: string, file: string): string {
  return (
    text
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<kbd>([\s\S]*?)<\/kbd>/gi, '`$1`')
      .replace(/<\/?(strong|b)>/gi, '**')
      .replace(/<\/?(em|i)>/gi, '*')
      .replace(/<\/?(span|sup|sub|small|mark|u|font)\b[^>]*>/gi, '')
      .replace(/<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      // VitePress 的行內元件：Badge 留文字，其他自閉合元件拿掉
      .replace(/<Badge\b[^>]*?\btext="([^"]*)"[^>]*\/>/g, '「$1」')
      .replace(/<[A-Z][A-Za-z0-9]*\b[^>]*\/>/g, '')
      // 本機圖片畫不出來，改成點了能打開的連結
      .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, alt: string, src: string) => {
        const { href } = resolveHref(src, file)
        return /^https?:/i.test(href) ? `![${alt}](${href})` : `🖼 [${alt || '圖片'}](${href})`
      })
      .replace(
        /(^|[^!])\[([^\]]*)\]\(\s*<?([^)\s>]*)>?((?:\s+"[^"]*")?)\s*\)/g,
        (_, before: string, label: string, href: string, title: string) =>
          `${before}[${label}](${resolveHref(href, file).href}${title})`,
      )
  )
}

export function transformInline(line: string, file: string): string {
  return splitCodeSpans(line)
    .map(part => (part.isCode ? part.text : transformText(part.text, file)))
    .join('')
}

// ---------------------------------------------------------------- 雜湊

/** 兩個 32 位元 FNV 變體拼成 16 位 hex，當 mermaid 快取的鍵 */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ code, 0x5bd1e995) >>> 0
    h2 = (h2 ^ (h2 >>> 13)) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------- 切段

type Line = { text: string; heading?: number }
type Container = { tag: string; isQuote: boolean }
type Fence = { char: string; size: number; info: string; indent: string }

const unquote = (text: string) => text.replace(/^(>\s?)+/, '')
const isBlank = (text: string) => unquote(text).trim() === ''
const isTableRow = (text: string) => unquote(text).trimStart().startsWith('|')
const isTableRule = (text: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(unquote(text).trim())

function isFenceClose(trimmed: string, fence: { char: string; size: number }): boolean {
  const run = /^(`{3,}|~{3,})\s*$/.exec(trimmed)?.[1] ?? ''
  return run !== '' && run[0] === fence.char && run.length >= fence.size
}

/** 從 `<svg` 開始找對應的 `</svg>`（算巢狀），回傳結尾之後的位置，找不到給 -1 */
export function matchSvgEnd(text: string): number {
  const tags = /<svg\b|<\/svg>/gi
  let depth = 0
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    depth += match[0][1] === '/' ? -1 : 1
    if (depth === 0) return match.index + match[0].length
  }
  return -1
}

const SEGMENT_FILLER = /[>\s]/g

export function parseMarkdown(source: string, file: string): Doc {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
  const segments: Segment[] = []
  const headings: Heading[] = []
  const slugCounts = new Map<string, number>()
  const containers: Container[] = []
  let buffer: Line[] = []
  let bufferSize = 0
  let fence: Fence | undefined

  const prefix = () => '> '.repeat(containers.filter(c => c.isQuote).length)

  const emit = (part: Line[]) => {
    const text = part.map(line => line.text).join('\n')
    if (text.replace(SEGMENT_FILLER, '') === '') return
    for (const line of part) {
      const heading = line.heading === undefined ? undefined : headings[line.heading]
      if (heading) heading.segment = segments.length
    }
    const links = new Set<string>()
    for (const match of text.matchAll(/\]\((file:\/\/[^)\s]+)/g)) {
      const url = match[1] ?? ''
      const target = fromFileUrl(url)
      if (target && isMarkdownPath(target.path)) links.add(url)
    }
    segments.push({ kind: 'md', text, links: [...links].slice(0, LINKS_LIMIT) })
  }

  const flush = () => {
    emit(buffer)
    buffer = []
    bufferSize = 0
  }

  /** 緩衝區滿了：fence 裡就先收再重開，否則切在最後一個空行；表格切開時把表頭帶到下一段 */
  const overflow = (incoming: string) => {
    if (fence) {
      const close = prefix() + fence.indent + fence.char.repeat(fence.size)
      buffer.push({ text: close })
      flush()
      const reopen = prefix() + fence.indent + fence.char.repeat(fence.size) + fence.info
      buffer = [{ text: reopen }]
      bufferSize = reopen.length + 1
      return
    }
    let cut = -1
    for (let i = buffer.length - 1; i > 0; i--) {
      if (isBlank(buffer[i]?.text ?? '')) {
        cut = i
        break
      }
    }
    if (cut > 0) {
      const kept = buffer.slice(cut + 1)
      emit(buffer.slice(0, cut))
      buffer = kept
      bufferSize = kept.reduce((sum, line) => sum + line.text.length + 1, 0)
      return
    }
    const [head, rule] = buffer
    flush()
    if (head && rule && isTableRow(head.text) && isTableRule(rule.text) && isTableRow(incoming)) {
      buffer = [{ text: head.text }, { text: rule.text }]
      bufferSize = head.text.length + rule.text.length + 2
    }
  }

  const push = (raw: string, heading?: number) => {
    let text = prefix() + raw
    // 一行就超過上限（巨大的表格列或段落）：只好硬切
    while (text.length > CHUNK_LIMIT) {
      if (buffer.length > 0) flush()
      buffer.push({ text: text.slice(0, CHUNK_LIMIT), heading })
      heading = undefined
      flush()
      text = text.slice(CHUNK_LIMIT)
    }
    for (let guard = 0; bufferSize + text.length + 1 > CHUNK_LIMIT && buffer.length > 0 && guard < 4; guard++) {
      overflow(text)
    }
    buffer.push({ text, heading })
    bufferSize += text.length + 1
  }

  const openContainer = (tag: string, label: string | undefined, isQuote: boolean) => {
    if (isQuote) push('')
    containers.push({ tag, isQuote })
    if (label !== undefined) {
      push(label)
      push('')
    }
  }

  const closeContainer = (tag: string) => {
    let found = -1
    for (let i = containers.length - 1; i >= 0; i--) {
      if (containers[i]?.tag === tag) {
        found = i
        break
      }
    }
    if (found < 0) return
    containers.length = found
    push('')
  }

  const lineAt = (at: number) => lines[at] ?? ''
  let index = 0
  if (lineAt(0).trim() === '---') {
    const end = lines.findIndex((line, at) => at > 0 && (line.trim() === '---' || line.trim() === '...'))
    if (end > 0) {
      const yaml = lines.slice(1, end).join('\n')
      if (yaml.trim() !== '') segments.push({ kind: 'frontmatter', source: yaml.slice(0, CHUNK_LIMIT) })
      index = end + 1
    }
  }

  for (; index < lines.length; index++) {
    const line = lineAt(index)
    const trimmed = line.trim()

    if (fence) {
      push(line)
      if (isFenceClose(trimmed, fence)) fence = undefined
      continue
    }

    const fenceOpen = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)
    if (fenceOpen) {
      const [, indent = '', run = '', info = ''] = fenceOpen
      const marker = { char: run.slice(0, 1), size: run.length }
      if ((info.trim().split(/\s+/)[0] ?? '').toLowerCase() === 'mermaid') {
        const body: string[] = []
        let scan = index + 1
        for (; scan < lines.length && !isFenceClose(lineAt(scan).trim(), marker); scan++) body.push(lineAt(scan))
        flush()
        const code = body.join('\n')
        segments.push({ kind: 'mermaid', code, hash: hashText(MERMAID_SALT + code) })
        index = scan
        continue
      }
      fence = { ...marker, info, indent }
      push(line)
      continue
    }

    if (trimmed.startsWith('<!--')) {
      let scan = index
      while (scan < lines.length && !lineAt(scan).includes('-->')) scan++
      index = scan
      continue
    }

    const colonOpen = /^:{3,}\s*([A-Za-z]+)\s*(.*)$/.exec(trimmed)
    if (colonOpen) {
      const [, name = '', rest = ''] = colonOpen
      const kind = CONTAINERS[name.toLowerCase()] ?? { icon: '▌', label: name }
      const title = rest.trim()
      openContainer(':::', `**${kind.icon} ${title ? transformInline(title, file) : kind.label}**`, true)
      continue
    }
    if (/^:{3,}\s*$/.test(trimmed)) {
      closeContainer(':::')
      continue
    }

    const detailsOpen = /^<details\b[^>]*>(.*)$/i.exec(trimmed)
    if (detailsOpen) {
      const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(detailsOpen[1] ?? '')?.[1]
      openContainer('details', summary === undefined ? undefined : `**▸ ${transformInline(summary.trim(), file)}**`, true)
      continue
    }
    const summaryOnly = /^<summary\b[^>]*>([\s\S]*?)<\/summary>$/i.exec(trimmed)
    if (summaryOnly) {
      push(`**▸ ${transformInline((summaryOnly[1] ?? '').trim(), file)}**`)
      push('')
      continue
    }
    if (/^<\/details>$/i.test(trimmed)) {
      closeContainer('details')
      continue
    }

    const component = /^<([A-Z][A-Za-z0-9]*)\b([^>]*?)(\/?)>$/.exec(trimmed)
    if (component) {
      const [, name = '', attrs = '', selfClosing = ''] = component
      if (selfClosing) {
        flush()
        segments.push({ kind: 'note', text: `〔文件站的互動元件 <${name}>，這裡畫不出來，到文件站看〕` })
        continue
      }
      const label = /\blabel="([^"]*)"/.exec(attrs)?.[1]
      openContainer(name, label === undefined ? undefined : `**${label}**`, label !== undefined)
      continue
    }
    const componentClose = /^<\/([A-Z][A-Za-z0-9]*)>$/.exec(trimmed)
    if (componentClose) {
      closeContainer(componentClose[1] ?? '')
      continue
    }

    const svgLine = trimmed.replace(/^(<(?:figure|div|p|center|section)\b[^>]*>\s*)+/i, '')
    if (/^<svg\b/i.test(svgLine)) {
      let text = line.slice(line.search(/<svg\b/i))
      let scan = index
      while (matchSvgEnd(text) < 0 && scan + 1 < lines.length) {
        scan++
        text += '\n' + lineAt(scan)
      }
      const end = matchSvgEnd(text)
      const svg = end < 0 ? text : text.slice(0, end)
      flush()
      segments.push({ kind: 'svg', source: svg, alt: /\baria-label="([^"]*)"/.exec(svg)?.[1] ?? 'SVG 圖' })
      const after = end < 0 ? '' : text.slice(end).trim().replace(/^(<\/(?:figure|div|p|center|section)>\s*)+/i, '')
      if (after !== '') push(transformInline(after, file))
      index = scan
      continue
    }

    if (/^<\/?(div|figure|section|center|p|span|picture)\b[^>]*>$/i.test(trimmed)) continue

    const caption = /^<figcaption\b[^>]*>([\s\S]*?)(<\/figcaption>)?$/i.exec(trimmed)
    if (caption) {
      let text = caption[1] ?? ''
      let scan = index
      if (!caption[2]) {
        while (scan + 1 < lines.length && !/<\/figcaption>/i.test(lineAt(scan))) {
          scan++
          text += ' ' + lineAt(scan).trim()
        }
        text = text.replace(/<\/figcaption>[\s\S]*$/i, '')
      }
      push('')
      push(`*${transformInline(text.trim(), file)}*`)
      push('')
      index = scan
      continue
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const [, hashes = '', rest = ''] = heading
      const level = hashes.length
      let raw = rest.replace(/\s+#+\s*$/, '').trim()
      let customId: string | undefined
      const idMatch = /\s*\{#([^}]+)\}\s*$/.exec(raw)
      if (idMatch) {
        customId = idMatch[1]
        raw = raw.slice(0, idMatch.index).trim()
      }
      const text = plainText(raw)
      const base = customId ?? slugify(text)
      const seen = slugCounts.get(base) ?? 0
      slugCounts.set(base, seen + 1)
      if (level <= 3 && containers.length === 0) flush()
      headings.push({ level, text, slug: customId ?? (seen === 0 ? base : `${base}-${seen}`), segment: -1 })
      push(`${hashes} ${transformInline(raw, file)}`, headings.length - 1)
      continue
    }

    const definition = /^( {0,3}\[[^\]]+\]:\s*)<?([^\s>]+)>?(\s.*)?$/.exec(line)
    if (definition) {
      const [, lead = '', target = '', tail = ''] = definition
      push(`${lead}${resolveHref(target, file).href}${tail}`)
      continue
    }

    push(transformInline(line, file))
  }

  if (fence) push(fence.indent + fence.char.repeat(fence.size))
  flush()

  // 還沒落段的標題（理論上不會有）掛到最後一段，免得跳轉到 -1
  for (const heading of headings) if (heading.segment < 0) heading.segment = Math.max(0, segments.length - 1)

  const title = headings.find(h => h.level === 1)?.text ?? basename(file)
  return { title, segments, headings, pages: paginate(segments) }
}

// ---------------------------------------------------------------- 分頁與查找

function weight(segment: Segment): number {
  switch (segment.kind) {
    case 'md':
      return segment.text.length
    case 'svg':
      return segment.source.length
    case 'mermaid':
      return MERMAID_WEIGHT
    case 'frontmatter':
      return segment.source.length
    case 'note':
      return 200
  }
}

const startsMajorSection = (segment: Segment) => segment.kind === 'md' && /^#{1,2}\s/.test(segment.text)

export function paginate(segments: Segment[]): number[] {
  const pages = [0]
  let size = 0
  segments.forEach((segment, at) => {
    const add = weight(segment)
    const isFull = size + add > PAGE_HARD || (size >= PAGE_SOFT && startsMajorSection(segment))
    if (size > 0 && isFull) {
      pages.push(at)
      size = 0
    }
    size += add
  })
  return pages
}

/** 某一段在第幾頁 */
export function pageOf(doc: Doc, segment: number): number {
  let page = 0
  doc.pages.forEach((start, at) => {
    if (start <= segment) page = at
  })
  return page
}

/** 第幾頁涵蓋哪些段：[start, end) */
export function pageRange(doc: Doc, page: number): [number, number] {
  const at = Math.min(Math.max(0, page), doc.pages.length - 1)
  return [doc.pages[at] ?? 0, doc.pages[at + 1] ?? doc.segments.length]
}

/** 錨點 → 標題：先比 slug，再比 slug 化後的錨點，最後比標題文字 */
export function findHeading(doc: Doc, anchor: string): Heading | undefined {
  const wanted = safeDecode(anchor).replace(/^#/, '')
  if (wanted === '') return undefined
  const lower = wanted.toLowerCase()
  return (
    doc.headings.find(h => h.slug === wanted) ??
    doc.headings.find(h => h.slug === slugify(wanted)) ??
    doc.headings.find(h => h.text.toLowerCase() === lower)
  )
}
