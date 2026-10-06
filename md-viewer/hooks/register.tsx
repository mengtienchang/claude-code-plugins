import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MdViewerMode } from '../types'
import {
  CHROME_CANDIDATES,
  MERMAID_END,
  chromeArgv,
  mermaidCandidates,
  mermaidJobHtml,
  parseMermaidOutput,
  toMermaidResult,
  type MermaidResult,
} from './mermaid'
import {
  basename,
  dirname,
  findHeading,
  fromFileUrl,
  isMarkdownPath,
  normalizePath,
  pageOf,
  pageRange,
  parseMarkdown,
  type Doc,
  type Heading,
  type Segment,
} from './parse'
import { prepareInlineSvg } from './svg'

const PANE = 'md-viewer'
const RECENT_MAX = 20
const MATCH_MAX = 40
const DOC_CACHE_MAX = 30
/** Svg 元件的 source 上限 */
const SVG_LIMIT = 131072
const FILE_LIST_TTL = 30_000
const TICK_MS = 1500
const MERMAID_TIMEOUT_MS = 90_000
const ERROR_COLOR = '#cf222e'

const fileAtom = atom({ plugin: 'md-viewer', key: 'file' } as const, '')
const pageAtom = atom({ plugin: 'md-viewer', key: 'page' } as const, 0)
const revAtom = atom({ plugin: 'md-viewer', key: 'rev' } as const, 0)
const modeAtom = atom({ plugin: 'md-viewer', key: 'mode' } as const, 'doc' as MdViewerMode)
const followAtom = atom({ plugin: 'md-viewer', key: 'follow' } as const, true)
const recentAtom = atom({ plugin: 'md-viewer', key: 'recent' } as const, [] as string[])
const queryAtom = atom({ plugin: 'md-viewer', key: 'query' } as const, '')
const noticeAtom = atom({ plugin: 'md-viewer', key: 'notice' } as const, '')

// 模組變數只當快取：hot reload 會清空、重算就好；畫面要跟著變的值都在 $.state
const docs = new Map<string, { mtimeMs: number; doc: Doc }>()
const svgs = new Map<string, MermaidResult>()
const back: { file: string; page: number }[] = []
let fileList: { at: number; files: string[] } | undefined
let root = ''
let home = ''
let workDir = ''
let watched = { file: '', mtimeMs: -1 }
let isTicking = false

// ---------------------------------------------------------------- 小工具

function display(path: string): string {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

function truncate(text: string, size: number): string {
  return text.length > size ? `${text.slice(0, size - 1)}…` : text
}

async function absolutize($: EngineInterface, raw: string): Promise<string> {
  const text = raw.trim().replace(/^["']|["']$/g, '')
  if (text.startsWith('/')) return normalizePath(text)
  if (text.startsWith('~/')) return normalizePath(`${home}/${text.slice(2)}`)
  return normalizePath(`${await $.session.cwd()}/${text}`)
}

async function bump($: EngineInterface): Promise<void> {
  await update($, revAtom, rev => rev + 1)
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

function scrollSoon($: EngineInterface, key?: string): void {
  $.clock.after(150, () => {
    const target = key ? { to: { key }, in: PANE, block: 'start' as const } : { to: 'start' as const, in: PANE }
    void $.ui.scroll(target).catch(() => undefined)
  })
}

// ---------------------------------------------------------------- 文件

async function loadDoc($: EngineInterface, path: string): Promise<{ doc: Doc } | { error: string }> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) return { error: `找不到檔案：${display(path)}` }
  if (stat.kind !== 'file') return { error: `不是檔案：${display(path)}` }
  const hit = docs.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return { error: `讀不到 ${display(path)}（超過 4 MiB 或沒有權限）` }
  const entry = { mtimeMs: stat.mtimeMs, doc: parseMarkdown(text, path) }
  docs.delete(path)
  docs.set(path, entry)
  if (docs.size > DOC_CACHE_MAX) {
    const oldest = docs.keys().next().value
    if (oldest !== undefined) docs.delete(oldest)
  }
  return entry
}

async function remember($: EngineInterface, path: string): Promise<void> {
  const list = await update($, recentAtom, current => [path, ...current.filter(p => p !== path)].slice(0, RECENT_MAX))
  await $.store.set('recent', list)
}

async function openFile(
  $: EngineInterface,
  path: string,
  options: { anchor?: string; page?: number; isBack?: boolean } = {},
): Promise<void> {
  const current = await read($, fileAtom)
  if (!options.isBack && current && current !== path) {
    back.push({ file: current, page: await read($, pageAtom) })
    if (back.length > 50) back.shift()
  }
  let page = options.page ?? 0
  let key: string | undefined
  if (options.anchor) {
    const loaded = await loadDoc($, path)
    if ('doc' in loaded) {
      const heading = findHeading(loaded.doc, options.anchor)
      if (heading) {
        page = pageOf(loaded.doc, heading.segment)
        key = `seg-${heading.segment}`
      }
    }
  }
  await update($, fileAtom, () => path)
  await update($, pageAtom, () => page)
  await update($, modeAtom, () => 'doc')
  await remember($, path)
  await $.ui.open({ id: PANE, title: basename(path) })
  scrollSoon($, key)
  void tick($)
}

async function goBack($: EngineInterface): Promise<void> {
  const previous = back.pop()
  if (previous) await openFile($, previous.file, { page: previous.page, isBack: true })
}

async function jump($: EngineInterface, doc: Doc, heading: Heading): Promise<void> {
  await update($, pageAtom, () => pageOf(doc, heading.segment))
  await update($, modeAtom, () => 'doc')
  scrollSoon($, `seg-${heading.segment}`)
}

async function goPage($: EngineInterface, page: number, count: number): Promise<void> {
  if (page < 0 || page >= count) return
  await update($, pageAtom, () => page)
  scrollSoon($)
}

async function followLink($: EngineInterface, href: string): Promise<void> {
  const target = fromFileUrl(href)
  if (!target) return
  const current = await read($, fileAtom)
  if (target.path === current) {
    const loaded = await loadDoc($, current)
    const heading = 'doc' in loaded ? findHeading(loaded.doc, target.hash) : undefined
    if (heading && 'doc' in loaded) await jump($, loaded.doc, heading)
    return
  }
  if (!(await $.fs.exists(target.path))) {
    $.ui.toast(`找不到 ${display(target.path)}`)
    return
  }
  await openFile($, target.path, { anchor: target.hash })
}

async function reload($: EngineInterface): Promise<void> {
  docs.delete(await read($, fileAtom))
  for (const [hash, result] of svgs) if ('error' in result) svgs.delete(hash)
  fileList = undefined
  await bump($)
  void tick($)
}

// ---------------------------------------------------------------- 找檔

async function loadFileList($: EngineInterface): Promise<string[]> {
  if (fileList && Date.now() - fileList.at < FILE_LIST_TTL) return fileList.files
  const base = root || (await $.session.root())
  const listed = await $.process
    .run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md', '*.markdown'], {
      cwd: base,
    })
    .catch(() => undefined)
  const files =
    listed && listed.exitCode === 0
      ? [...new Set(listed.stdout.split('\0').filter(Boolean))].map(rel => `${base}/${rel}`)
      : []
  fileList = { at: Date.now(), files }
  return files
}

function matchFiles(files: readonly string[], query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const scored: { file: string; score: number }[] = []
  for (const file of files) {
    const shown = display(file).toLowerCase()
    if (!terms.every(term => shown.includes(term))) continue
    const name = basename(shown)
    scored.push({ file, score: (terms.every(term => name.includes(term)) ? 0 : 1000) + shown.length })
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, MATCH_MAX)
    .map(entry => entry.file)
}

async function submitQuery($: EngineInterface, value: string): Promise<void> {
  const text = value.trim()
  if (text === '') return
  const cut = text.lastIndexOf('#')
  const [rawPath, anchor] = cut > 0 ? [text.slice(0, cut), text.slice(cut + 1)] : [text, '']
  const asPath = await absolutize($, rawPath)
  const stat = await $.fs.stat(asPath).catch(() => undefined)
  if (stat?.kind === 'file') {
    await openFile($, asPath, { anchor })
    return
  }
  const [first] = matchFiles(await loadFileList($), text)
  if (first) await openFile($, first)
  else $.ui.toast('沒有符合的 md')
}

// ---------------------------------------------------------------- 背景：存檔刷新與 mermaid

async function firstExisting($: EngineInterface, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await $.fs.exists(candidate)) return candidate
  }
  return undefined
}

/** 收掉這個 profile 殘留的 Chrome 程序：Chrome 印完常常不自己退出，留著會撞到下一批的 profile 鎖 */
async function killStrays($: EngineInterface, profile: string): Promise<void> {
  // 樣式不能以 - 開頭：macOS 的 pkill 會把 --user-data-dir 當成自己的選項
  await $.process.run(['pkill', '-f', `user-data-dir=${profile}`]).catch(() => undefined)
}

/**
 * 一批 mermaid 圖交給 headless Chrome。讀到結尾標記就離開迴圈（引擎收掉子程序）；
 * 逾時或 Chrome 沒印出東西時，沒拿到結果的 hash 不在回傳值裡。
 */
async function renderMermaid(
  $: EngineInterface,
  items: readonly { hash: string; code: string }[],
  chrome: string,
  mermaidJs: string,
): Promise<Record<string, MermaidResult>> {
  const job = `${workDir}/job.html`
  const profile = `${workDir}/chrome-profile`
  await $.fs.write(job, mermaidJobHtml(mermaidJs, items))
  await killStrays($, profile)
  const stream = $.process.spawn({ argv: chromeArgv(chrome, profile, job) })
  let output = ''
  const timer = $.clock.after(MERMAID_TIMEOUT_MS, () => {
    void stream.return(undefined as never).catch(() => undefined)
  })
  try {
    for await (const chunk of stream) {
      if (chunk.stream !== 'stdout') continue
      output += chunk.text
      if (output.includes(MERMAID_END)) break
    }
  } catch {
    // 逾時收掉串流、或 Chrome 起不來：當作這批沒拿到結果
  } finally {
    timer.cancel()
    await killStrays($, profile)
  }
  return parseMermaidOutput(output)
}

async function renderPending(
  $: EngineInterface,
  file: string,
  pending: readonly { hash: string; code: string }[],
): Promise<void> {
  const todo: { hash: string; code: string }[] = []
  for (const item of pending) {
    const cached = await $.fs
      .read(`${workDir}/svg/${item.hash}.json`)
      .then(text => toMermaidResult(JSON.parse(text)))
      .catch(() => undefined)
    if (cached) svgs.set(item.hash, cached)
    else todo.push(item)
  }
  if (todo.length === 0) return
  const chrome = await firstExisting($, CHROME_CANDIDATES)
  const mermaidJs = await firstExisting($, [
    ...mermaidCandidates(dirname(file)),
    ...(root ? mermaidCandidates(root) : []),
  ])
  if (!chrome || !mermaidJs) {
    const error = chrome
      ? '找不到 node_modules/mermaid（從這份 md 往上找、再找專案根目錄），先顯示原始碼'
      : '找不到 Chrome，先顯示原始碼'
    for (const item of todo) svgs.set(item.hash, { error })
    return
  }
  await update($, noticeAtom, () => `mermaid 渲染中（${todo.length} 張）…`)
  try {
    const results = await renderMermaid($, todo, chrome, mermaidJs)
    for (const item of todo) {
      const result = results[item.hash]
      if (result) {
        svgs.set(item.hash, result)
        await $.fs.write(`${workDir}/svg/${item.hash}.json`, JSON.stringify(result))
      } else {
        svgs.set(item.hash, { error: 'Chrome 沒有在時限內畫完，按「重新載入」再試' })
      }
    }
  } finally {
    await update($, noticeAtom, () => '')
  }
}

/** 每 1.5 秒：窗格開著才做事——檔案改了就重畫，有還沒畫的 mermaid 就畫 */
async function tick($: EngineInterface): Promise<void> {
  if (isTicking) return
  isTicking = true
  try {
    const file = await read($, fileAtom)
    if (!file || !(await isPaneOpen($))) return
    const stat = await $.fs.stat(file).catch(() => undefined)
    const mtimeMs = stat?.mtimeMs ?? -1
    const isChanged = watched.file === file && watched.mtimeMs !== mtimeMs
    watched = { file, mtimeMs }
    if (isChanged) await bump($)
    const loaded = await loadDoc($, file)
    if (!('doc' in loaded)) return
    const pending = new Map<string, string>()
    for (const segment of loaded.doc.segments) {
      if (segment.kind === 'mermaid' && !svgs.has(segment.hash)) pending.set(segment.hash, segment.code)
    }
    if (pending.size === 0) return
    await renderPending(
      $,
      file,
      [...pending].map(([hash, code]) => ({ hash, code })),
    )
    await bump($)
  } catch (err) {
    $.ui.log(`md-viewer: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  } finally {
    isTicking = false
  }
}

/** Claude 改了 md：記進最近開過；跟隨開著、窗格也開著，就換到那份 */
async function onEdited($: EngineInterface, path: string): Promise<void> {
  await remember($, path)
  if (!(await read($, followAtom)) || !(await isPaneOpen($))) return
  if ((await read($, fileAtom)) !== path) await openFile($, path)
  else void tick($)
}

// ---------------------------------------------------------------- 註冊

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    root = await $.session.root().catch(() => '')
    home = (await $.env.get('HOME')) ?? ''
    workDir = `${home || '/tmp'}/.cache/claude-md-viewer`
    await $.command.register({
      name: 'md',
      description: '在窗格裡渲染 Markdown；不帶路徑就開找檔畫面',
      argumentHint: '[路徑[#錨點]]',
    })
    const stored = await $.store.get('recent')
    if (Array.isArray(stored)) {
      const list = stored.filter((item): item is string => typeof item === 'string').slice(0, RECENT_MAX)
      await update($, recentAtom, current => (current.length > 0 ? current : list))
    }
    $.clock.every(TICK_MS, () => void tick($))
    void loadFileList($)
    return next(e)
  })

  on('command.run', { command: 'md' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') {
      const file = await read($, fileAtom)
      if (!file) {
        await update($, modeAtom, () => 'open')
        void loadFileList($).then(() => bump($))
      }
      await $.ui.open({ id: PANE, title: file ? basename(file) : 'Markdown', focus: true })
      return { text: file ? `Markdown 窗格：${display(file)}` : 'Markdown 窗格已開，輸入檔名找檔案。' }
    }
    const cut = arg.lastIndexOf('#')
    const [rawPath, anchor] = cut > 0 ? [arg.slice(0, cut), arg.slice(cut + 1)] : [arg, '']
    const path = await absolutize($, rawPath)
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (!stat || stat.kind !== 'file') return { text: `找不到檔案：${path}` }
    await openFile($, path, { anchor })
    return { text: `已在 Markdown 窗格開啟 ${display(path)}` }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const path = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : undefined
    if (!path || !isMarkdownPath(path) || result.isError === true || result.deny !== undefined) return result
    void onEdited($, path)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Code } = table
    // 元件表在每個介面都補齊所有名字（缺的畫成空片段），所以看介面決定畫不畫得出來
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const Input = e.surface !== 'mobile' && 'Input' in table ? table.Input : undefined
    const [file, page, , mode, follow, recent, query, notice] = await Promise.all([
      read($, fileAtom),
      read($, pageAtom),
      read($, revAtom),
      read($, modeAtom),
      read($, followAtom),
      read($, recentAtom),
      read($, queryAtom),
      read($, noticeAtom),
    ])
    const loaded = file ? await loadDoc($, file) : undefined
    const doc = loaded && 'doc' in loaded ? loaded.doc : undefined
    const setMode = (next: MdViewerMode) => () => void update($, modeAtom, () => next)

    const tabs = (
      <Box key="tabs" flexDirection="row" flexWrap="wrap" gap={1}>
        <Button key="tab-doc" label="文件" hotkey="d" variant={mode === 'doc' ? 'primary' : 'secondary'} onPress={setMode('doc')} />
        <Button key="tab-toc" label="目錄" hotkey="t" variant={mode === 'toc' ? 'primary' : 'secondary'} onPress={setMode('toc')} />
        <Button
          key="tab-open"
          label="開檔"
          hotkey="o"
          variant={mode === 'open' ? 'primary' : 'secondary'}
          onPress={() => {
            void update($, modeAtom, () => 'open')
            void loadFileList($).then(() => bump($))
          }}
        />
        {back.length > 0 && <Button key="back" label="返回" hotkey="u" onPress={() => void goBack($)} />}
        <Button key="reload" label="重新載入" hotkey="r" onPress={() => void reload($)} />
        <Button
          key="follow"
          label={follow ? '跟隨編輯：開' : '跟隨編輯：關'}
          hotkey="f"
          onPress={() => void update($, followAtom, value => !value)}
        />
      </Box>
    )

    const drawSvg = (source: string, alt: string) => {
      if (!Svg) return <Text dimColor>{`〔圖：${alt}。這個介面畫不了 SVG〕`}</Text>
      if (source.length > SVG_LIMIT) return <Text dimColor>{`〔圖太大（${source.length} 字），畫不出來〕`}</Text>
      return <Svg source={source} alt={alt} />
    }

    const drawSegment = (segment: Segment, at: number) => {
      const key = `seg-${at}`
      switch (segment.kind) {
        case 'md':
          return segment.links.length > 0 ? (
            <Markdown
              key={key}
              text={segment.text}
              pressableLinks={segment.links}
              onLinkPress={link => void followLink($, link.href)}
            />
          ) : (
            <Markdown key={key} text={segment.text} />
          )
        case 'frontmatter':
          return (
            <Box key={key}>
              <Code source={segment.source} language="yaml" />
            </Box>
          )
        case 'note':
          return (
            <Box key={key}>
              <Text dimColor italic>
                {segment.text}
              </Text>
            </Box>
          )
        case 'svg':
          return <Box key={key}>{drawSvg(prepareInlineSvg(segment.source), segment.alt)}</Box>
        case 'mermaid': {
          const result = svgs.get(segment.hash)
          if (!result) {
            return (
              <Box key={key}>
                <Text dimColor>mermaid 圖渲染中…</Text>
              </Box>
            )
          }
          if ('error' in result) {
            return (
              <Box key={key} flexDirection="column">
                <Text color={ERROR_COLOR}>{`mermaid 畫不出來：${truncate(result.error, 300)}`}</Text>
                <Code source={segment.code} language="mermaid" />
              </Box>
            )
          }
          return <Box key={key}>{drawSvg(result.svg, 'mermaid 圖')}</Box>
        }
      }
    }

    const fileButtons = (paths: readonly string[], prefix: string) => (
      <Box key={`${prefix}-list`} flexDirection="column">
        {paths.map((path, at) => (
          <Button key={`${prefix}-${at}`} plain label={display(path)} onPress={() => void openFile($, path)} />
        ))}
      </Box>
    )

    const openView = () => {
      const isSearching = query.trim() !== ''
      const matches = isSearching ? matchFiles(fileList?.files ?? [], query) : []
      return (
        <Box key="open" flexDirection="column" gap={1}>
          {Input ? (
            <Input
              key="query"
              label="找 md"
              placeholder="檔名或路徑片段，空白分隔；Enter 開第一個，也可以直接貼路徑"
              value={query}
              autoFocus
              onInput={value => void update($, queryAtom, () => value)}
              onSubmit={value => void submitQuery($, value)}
            />
          ) : (
            <Text dimColor>這個介面沒有輸入框，用 /md 路徑 開檔。</Text>
          )}
          {isSearching && !fileList && <Text dimColor>載入檔案清單中…</Text>}
          {isSearching && fileList && matches.length === 0 && <Text dimColor>沒有符合的 md。</Text>}
          {isSearching && matches.length > 0 && fileButtons(matches, 'match')}
          {!isSearching && <Text bold>最近開過</Text>}
          {!isSearching && recent.length === 0 && <Text dimColor>還沒有。</Text>}
          {!isSearching && recent.length > 0 && fileButtons(recent, 'recent')}
        </Box>
      )
    }

    const tocView = (shown: Doc) => {
      const items = shown.headings.filter(heading => heading.level <= 3)
      if (items.length === 0) return <Text dimColor>這份文件沒有 h1–h3 標題。</Text>
      return (
        <Box key="toc" flexDirection="column">
          {items.map((heading, at) => (
            <Box key={`toc-${at}`} paddingLeft={(heading.level - 1) * 2}>
              <Button
                key={`toc-button-${at}`}
                plain
                label={truncate(heading.text, 90)}
                onPress={() => void jump($, shown, heading)}
              />
            </Box>
          ))}
        </Box>
      )
    }

    const docView = (shown: Doc) => {
      const count = shown.pages.length
      const current = Math.min(Math.max(0, page), count - 1)
      const [start, end] = pageRange(shown, current)
      const pager = (where: 'top' | 'bottom') =>
        count > 1 && (
          <Box key={`pager-${where}`} flexDirection="row" gap={1} alignItems="center">
            <Button
              key={`prev-${where}`}
              label="上一頁"
              hotkey={where === 'top' ? 'b' : undefined}
              dimColor={current === 0}
              onPress={() => void goPage($, current - 1, count)}
            />
            <Text dimColor>{`第 ${current + 1} / ${count} 頁`}</Text>
            <Button
              key={`next-${where}`}
              label="下一頁"
              hotkey={where === 'top' ? 'n' : undefined}
              dimColor={current === count - 1}
              onPress={() => void goPage($, current + 1, count)}
            />
          </Box>
        )
      return (
        <Box key="doc" flexDirection="column" gap={1}>
          {pager('top')}
          {shown.segments.length === 0 && <Text dimColor>（空白文件）</Text>}
          {shown.segments.slice(start, end).map((segment, offset) => drawSegment(segment, start + offset))}
          {pager('bottom')}
        </Box>
      )
    }

    const body = () => {
      if (mode === 'open') return openView()
      if (!file) return <Text dimColor>還沒開檔。按「開檔」找檔案，或輸入 /md 路徑。</Text>
      if (!doc) return <Text color={ERROR_COLOR}>{loaded && 'error' in loaded ? loaded.error : '讀不到檔案'}</Text>
      return mode === 'toc' ? tocView(doc) : docView(doc)
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {file !== '' && mode !== 'open' && <Text dimColor>{display(file)}</Text>}
        {notice !== '' && <Text dimColor>{notice}</Text>}
        {body()}
      </Box>
    )
  })
}
