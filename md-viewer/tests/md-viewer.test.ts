import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

import { mermaidJobHtml, parseMermaidOutput } from '../hooks/mermaid'
import {
  PAGE_HARD,
  findHeading,
  pageRange,
  parseMarkdown,
  toFileUrl,
  type Doc,
  type MdSegment,
  type Segment,
} from '../hooks/parse'
import { prepareInlineSvg } from '../hooks/svg'

/** 窗格的 Markdown 元件一個最多 10000 字 */
const MARKDOWN_LIMIT = 10000

const mdSegments = (doc: Doc) => doc.segments.filter((s): s is MdSegment => s.kind === 'md')
const segmentSize = (segment: Segment) =>
  segment.kind === 'md' ? segment.text.length : segment.kind === 'svg' ? segment.source.length : 0

// ---------------------------------------------------------------- 解析：純函數

test('切段：每段都放得進一個 Markdown 元件；fence 切開時收尾再重開，表格切開時把表頭帶到下一段', async () => {
  const code = Array.from({ length: 1200 }, (_, i) => `const value${i} = ${i} // padding`).join('\n')
  const rows = Array.from({ length: 700 }, (_, i) => `| 第 ${i} 列 | 說明文字說明文字 | ${i * 3} |`).join('\n')
  const source = `# 大文件\n\n\`\`\`ts\n${code}\n\`\`\`\n\n| 欄 | 說明 | 數字 |\n| --- | --- | --- |\n${rows}\n`
  const doc = parseMarkdown(source, '/repo/big.md')
  const segments = mdSegments(doc)

  expect(segments.every(s => s.text.length < MARKDOWN_LIMIT)).toBe(true)

  // 程式碼被切成好幾段，每段都是完整的 fence
  const fenced = segments.filter(s => s.text.includes('const value'))
  expect(fenced.length).toBeGreaterThan(2)
  for (const segment of fenced) {
    const lines = segment.text.split('\n').filter(line => line.trim() !== '')
    const opens = lines.filter(line => line.startsWith('```ts')).length
    const closes = lines.filter(line => line === '```').length
    expect(opens).toBe(1)
    expect(closes).toBe(1)
  }
  // 沒有任何一行被丟掉
  expect(fenced.reduce((sum, s) => sum + (s.text.match(/const value/g)?.length ?? 0), 0)).toBe(1200)

  // 表格的每一段都從表頭開始
  const tables = segments.filter(s => s.text.includes('| 第 '))
  expect(tables.length).toBeGreaterThan(1)
  for (const segment of tables) expect(segment.text.trimStart().startsWith('| 欄 | 說明 | 數字 |\n| --- | --- | --- |')).toBe(true)
  expect(tables.reduce((sum, s) => sum + (s.text.match(/\| 第 /g)?.length ?? 0), 0)).toBe(700)
})

test('mermaid 與內嵌 svg 拆成圖段；::: 容器、<details>、帶 label 的元件轉成引用，引用結束後的段落不會黏進去', async () => {
  const source = [
    '段落一',
    '::: warning 小心刪除',
    '不可逆',
    ':::',
    '段落二',
    '',
    '<details><summary>展開看 <code>細節</code></summary>',
    '',
    '藏起來的內容',
    '',
    '</details>',
    '',
    '<FoldColumn label="依據">',
    '',
    '- 第一條',
    '',
    '</FoldColumn>',
    '',
    '<DesignChainMap chain="context" />',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    '',
    '<figure>',
    '<svg viewBox="0 0 10 10" aria-label="兩個方塊">',
    '<rect width="5" height="5"/>',
    '</svg>',
    '<figcaption>圖一：<code>兩個</code>方塊</figcaption>',
    '</figure>',
    '',
    '## 之後的標題',
  ].join('\n')
  const doc = parseMarkdown(source, '/repo/a.md')
  // 圖說自成一段，h2 另起一段
  const kinds = doc.segments.map(s => s.kind)
  expect(kinds).toEqual(['md', 'note', 'mermaid', 'svg', 'md', 'md'])

  const [first] = mdSegments(doc)
  expect(first?.text).toContain('> **⚠️ 小心刪除**')
  expect(first?.text).toContain('> 不可逆')
  expect(first?.text).toContain('\n\n段落二')
  expect(first?.text).not.toContain('> 段落二')
  expect(first?.text).toContain('> **▸ 展開看 `細節`**')
  expect(first?.text).toContain('> 藏起來的內容')
  expect(first?.text).toContain('> **依據**')
  expect(first?.text).toContain('> - 第一條')
  expect(first?.text).not.toContain('<details>')
  expect(first?.text).not.toContain('FoldColumn')

  const mermaid = doc.segments[2]
  expect(mermaid?.kind === 'mermaid' && mermaid.code).toBe('flowchart LR\n  A --> B')
  const svg = doc.segments[3]
  expect(svg?.kind === 'svg' && svg.alt).toBe('兩個方塊')
  expect(svg?.kind === 'svg' && svg.source.endsWith('</svg>')).toBe(true)

  const caption = doc.segments[4]
  expect(caption?.kind === 'md' && caption.text).toContain('*圖一：`兩個`方塊*')
  const last = doc.segments[5]
  expect(last?.kind === 'md' && last.text.startsWith('## 之後的標題')).toBe(true)
  expect(doc.headings.map(h => [h.text, h.segment])).toEqual([['之後的標題', 5]])
})

test('相對連結轉成 file:// 絕對網址，指向 md 的與錨點列為窗格內跳轉；行內 code 裡的不動，本機圖片改成連結', async () => {
  const file = '/repo/docs/a/guide.md'
  const source = [
    '見 [B 文件](../b.md#段落)、[程式](./c.ts#L3)、[本節](#本節)、[外站](https://example.com/x)。',
    '`[不轉](./no.md)` 與 [站內](/api/x)',
    '![架構圖](./img/arch.png)',
    '',
    '[ref]: ./d.md',
  ].join('\n')
  const doc = parseMarkdown(source, file)
  const [segment] = mdSegments(doc)
  const b = `${toFileUrl('/repo/docs/b.md')}#${encodeURIComponent('段落')}`
  const anchor = `${toFileUrl(file)}#${encodeURIComponent('本節')}`
  const ts = `${toFileUrl('/repo/docs/a/c.ts')}#L3`
  const d = toFileUrl('/repo/docs/a/d.md')

  expect(segment?.text).toContain(`[B 文件](${b})`)
  expect(segment?.text).toContain(`[程式](${ts})`)
  expect(segment?.text).toContain(`[本節](${anchor})`)
  expect(segment?.text).toContain('[外站](https://example.com/x)')
  expect(segment?.text).toContain('`[不轉](./no.md)`')
  expect(segment?.text).toContain('[站內](/api/x)')
  expect(segment?.text).toContain(`🖼 [架構圖](${toFileUrl('/repo/docs/a/img/arch.png')})`)
  expect(segment?.text).toContain(`[ref]: ${d}`)
  // 只有 md 與錨點是窗格內跳轉；.ts 與圖片交給介面自己開
  expect([...(segment?.links ?? [])].sort()).toEqual([anchor, b].sort())
})

test('標題的 slug 跟 VitePress 同一套（全形標點、重複加序號、{#自訂}），網址編碼過的錨點也找得到', async () => {
  const source = ['## 授權模型：五層', '', '## 授權模型：五層', '', '### Step 1: Setup', '', '## API 參考 {#api-ref}', ''].join('\n')
  const doc = parseMarkdown(source, '/repo/a.md')
  expect(doc.headings.map(h => h.slug)).toEqual(['授權模型-五層', '授權模型-五層-1', 'step-1-setup', 'api-ref'])
  expect(doc.headings.map(h => h.text)).toEqual(['授權模型：五層', '授權模型：五層', 'Step 1: Setup', 'API 參考'])

  expect(findHeading(doc, encodeURIComponent('授權模型-五層'))).toBe(doc.headings[0])
  expect(findHeading(doc, '授權模型-五層-1')).toBe(doc.headings[1])
  expect(findHeading(doc, 'api-ref')).toBe(doc.headings[3])
  // 手寫的錨點照標題原文寫也找得到
  expect(findHeading(doc, 'Step 1: Setup')).toBe(doc.headings[2])
  expect(findHeading(doc, '不存在')).toBeUndefined()
})

test('分頁：一頁不超過硬上限，過了軟上限遇到 h1/h2 就換頁；每個標題都找得到所在的頁', async () => {
  const paragraph = (seed: number) =>
    Array.from({ length: 60 }, (_, i) => `第 ${seed}-${i} 行的內容，寫得長一點好把分頁撐起來。`).join('\n')
  const sections = Array.from({ length: 12 }, (_, i) => `## 第 ${i} 節\n\n${paragraph(i)}\n\n${paragraph(i + 100)}`)
  const doc = parseMarkdown(`# 長文件\n\n${sections.join('\n\n')}`, '/repo/long.md')

  expect(doc.pages.length).toBeGreaterThan(1)
  doc.pages.forEach((_, page) => {
    const [start, end] = pageRange(doc, page)
    const size = doc.segments.slice(start, end).reduce((sum, s) => sum + segmentSize(s), 0)
    expect(size).toBeLessThanOrEqual(PAGE_HARD + MARKDOWN_LIMIT)
    if (page > 0) {
      const opener = doc.segments[start]
      expect(opener?.kind === 'md' && /^#{1,2} /.test(opener.text)).toBe(true)
    }
  })

  // 沒有標題的長文件只能靠硬上限換頁
  const flat = parseMarkdown(Array.from({ length: 40 }, (_, i) => paragraph(i)).join('\n\n'), '/repo/flat.md')
  expect(flat.pages.length).toBeGreaterThan(1)
  flat.pages.forEach((_, page) => {
    const [start, end] = pageRange(flat, page)
    expect(flat.segments.slice(start, end).reduce((sum, s) => sum + segmentSize(s), 0)).toBeLessThanOrEqual(PAGE_HARD)
  })
})

test('內嵌 svg 當圖片畫得出來：補 xmlns 與固有尺寸、配色變數定義在自己身上、HTML 實體換成數字實體', async () => {
  const source =
    '<svg viewBox="0 0 722 222" role="img" style="width:100%;height:auto;color:var(--vp-c-text-2)" aria-label="x">' +
    '<text style="fill:var(--vp-c-text-1)">A&nbsp;B&amp;C&rarr;D</text></svg>'
  const svg = prepareInlineSvg(source)
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(svg).toContain('width="722" height="222"')
  expect(svg).toContain('style="color:var(--vp-c-text-2);background:#ffffff"')
  expect(svg).not.toContain('width:100%')
  expect(svg).toContain('--vp-c-text-1:#3c3c43')
  expect(svg).toContain('--vp-c-text-2:#67676c')
  expect(svg).toContain('A&#160;B&amp;C&#8594;D')

  // 已經寫了寬度就不動，沒有 style 也鋪白底
  const sized = prepareInlineSvg('<svg width="40" height="20" viewBox="0 0 10 5"><rect/></svg>')
  expect(sized).not.toContain('width="10"')
  expect(sized).toContain('style="background:#ffffff"')
})

test('Chrome 的輸出：夾在標記之間的結果取得回來、跳脫過的字元還原；標記不完整或形狀不對的不收', async () => {
  const dumped =
    '<html><body><pre id="out">@@MDV-BEGIN@@' +
    '{"h1":{"svg":"\\u003csvg\\u003e\\u0026amp;\\u003c/svg\\u003e"},"h2":{"error":"Parse error on line 2"},"h3":{"bogus":1},' +
    // XML 解析失敗時瀏覽器給的是 parsererror 頁，不是 svg：不收
    '"h4":{"svg":"\\u003chtml xmlns=\\"http://www.w3.org/1999/xhtml\\"\\u003e\\u003cparsererror/\\u003e\\u003c/html\\u003e"}}' +
    '@@MDV-END@@</pre></body></html>'
  expect(parseMermaidOutput(dumped)).toEqual({ h1: { svg: '<svg>&amp;</svg>' }, h2: { error: 'Parse error on line 2' } })
  expect(parseMermaidOutput('<pre id="out">@@MDV-BEGIN@@{"h1":{"svg":"<svg')).toEqual({})
  expect(parseMermaidOutput('')).toEqual({})

  // 圖裡寫了 </script> 也不會提早結束資料區
  const html = mermaidJobHtml('/repo/node_modules/mermaid/dist/mermaid.min.js', [
    { hash: 'h1', code: 'flowchart LR\n  A["</script><b>"] --> B' },
  ])
  const data = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  expect(JSON.parse(data)).toEqual([{ hash: 'h1', code: 'flowchart LR\n  A["</script><b>"] --> B' }])
  expect(html).toContain('src="file:///repo/node_modules/mermaid/dist/mermaid.min.js"')
})

// ---------------------------------------------------------------- 窗格：站在引擎那一側

type Files = Map<string, { text: string; mtimeMs: number }>

// 檔案系統放在記憶體裡；session 在 /repo；開過的窗格記下來給 ui.panes 回答
const stubEngine = (on: On, files: Files) => {
  const panes = new Set<string>()
  const stored = new Map<string, unknown>()
  const toasts: string[] = []
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.stat', ($, e) => {
    const file = files.get(e.path)
    return file
      ? { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
      : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', ($, e) => {
    const file = files.get(e.path)
    return file ? { value: file.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', ($, e) => {
    files.set(e.path, { text: e.text, mtimeMs: 1 })
    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', () => {
    const listed = [...files.keys()].filter(path => path.endsWith('.md')).map(path => path.slice('/repo/'.length))
    return {
      value: { exitCode: 0, stdout: listed.join('\0'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.open', ($, e) => {
    panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.scroll', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // Claude 的編輯：引擎這一側當作改成功
  on('tool.call', () => ({ result: { filePath: '', oldString: '', newString: '', originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }))
  return { panes, stored, toasts }
}

const PANE_PROPS = {
  title: 'md',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'md-viewer', surface, component: 'Pane', requestId: 'md-viewer', props: PANE_PROPS })

// origin 與 presentation 由引擎蓋章，型別上補一個斷言
const md = ($: Engine, args: string) => $.command.run({ command: 'md', args } as CommandRunInput)

const startSession = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

const GUIDE = [
  '# 指南',
  '',
  '先看 [另一份](./other.md#第二節)。',
  '',
  '<svg viewBox="0 0 20 10" aria-label="小圖"><rect width="5" height="5" style="fill:var(--vp-c-brand-1)"/></svg>',
  '',
  '## 結尾',
].join('\n')
const OTHER = ['# 另一份', '', '## 第一節', '', '內容一', '', '## 第二節', '', '內容二'].join('\n')

test('/md 開檔：桌面版把內嵌 SVG 畫成 Svg、終端機退回文字；點 md 連結在窗格內換文件，返回回得去', async ($, on) => {
  const files: Files = new Map([
    ['/repo/docs/guide.md', { text: GUIDE, mtimeMs: 1 }],
    ['/repo/docs/other.md', { text: OTHER, mtimeMs: 1 }],
  ])
  const engine = stubEngine(on, files)
  await startSession($)

  const answer = await md($, 'docs/guide.md')
  expect(answer.text).toBe('已在 Markdown 窗格開啟 docs/guide.md')
  expect(engine.panes.has('md-viewer')).toBe(true)

  const terminal = await mountPane($, 'terminal')
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  expect(await terminal.find({ text: '〔圖：小圖。這個介面畫不了 SVG〕' })).toBeDefined()
  await terminal.unmount()

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ text: 'docs/guide.md' })).toBeDefined()
  const svg = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  expect(svg).toContain('--vp-c-brand-1:#3451b2')
  expect(await ui.find({ key: 'back' })).toBeUndefined()

  const link = `${toFileUrl('/repo/docs/other.md')}#${encodeURIComponent('第二節')}`
  await ui.press({ key: 'seg-0', link: { href: link } })
  expect(await ui.find({ text: 'docs/other.md' })).toBeDefined()
  expect(String((await ui.find({ type: 'Markdown' }))?.props.text)).toContain('# 另一份')

  await ui.press({ key: 'back' })
  expect(await ui.find({ text: 'docs/guide.md' })).toBeDefined()
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  await ui.unmount()

  expect((await md($, 'docs/nope.md')).text).toBe('找不到檔案：/repo/docs/nope.md')
})

test('Claude 編輯 md：跟隨開著就把窗格換到那份；關掉就只記進最近開過', async ($, on) => {
  const files: Files = new Map([
    ['/repo/docs/guide.md', { text: GUIDE, mtimeMs: 1 }],
    ['/repo/docs/other.md', { text: OTHER, mtimeMs: 1 }],
    ['/repo/notes.md', { text: '# 筆記', mtimeMs: 1 }],
  ])
  const engine = stubEngine(on, files)
  await startSession($)
  await md($, 'docs/guide.md')

  const edit = (path: string) => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })

  await edit('/repo/docs/other.md')
  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ text: 'docs/other.md' })).toBeDefined()

  await ui.press({ key: 'follow' })
  expect(String((await ui.find({ key: 'follow' }))?.props.label)).toBe('跟隨編輯：關')
  await edit('/repo/notes.md')
  expect(await ui.find({ text: 'docs/other.md' })).toBeDefined()
  expect(engine.stored.get('recent')).toEqual(['/repo/notes.md', '/repo/docs/other.md', '/repo/docs/guide.md'])

  // 改的不是 md 就不理
  await edit('/repo/src/app.ts')
  expect(engine.stored.get('recent')).toEqual(['/repo/notes.md', '/repo/docs/other.md', '/repo/docs/guide.md'])
  await ui.unmount()
})

test('找檔：輸入字串列出符合的 md（檔名符合的排前面），Enter 開第一個，也可以直接貼路徑', async ($, on) => {
  const files: Files = new Map([
    ['/repo/docs/guide.md', { text: GUIDE, mtimeMs: 1 }],
    ['/repo/docs/other.md', { text: OTHER, mtimeMs: 1 }],
    ['/repo/guide/readme.md', { text: '# 讀我', mtimeMs: 1 }],
  ])
  stubEngine(on, files)
  await startSession($)
  await md($, '')

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ key: 'query' })).toBeDefined()
  expect(await ui.find({ text: '還沒有。' })).toBeDefined()

  await ui.input({ key: 'query', text: 'guide', kind: 'change' })
  const labels = (await ui.findAll({ type: 'Button' }))
    .filter(button => String(button.props.key).startsWith('match-'))
    .map(button => String(button.props.label))
  expect(labels).toEqual(['docs/guide.md', 'guide/readme.md'])

  await ui.input({ key: 'query', text: 'guide' })
  expect(await ui.find({ text: 'docs/guide.md' })).toBeDefined()
  expect(String((await ui.find({ type: 'Markdown' }))?.props.text)).toContain('# 指南')

  await ui.press({ key: 'tab-open' })
  await ui.input({ key: 'query', text: '/repo/docs/other.md#第二節' })
  expect(await ui.find({ text: 'docs/other.md' })).toBeDefined()
  await ui.unmount()
})
