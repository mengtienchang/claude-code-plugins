import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, CommandRunInput, On } from 'claude-code'

const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 1_000,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 20_000,
}

// 站在引擎那一側：檔案系統放在記憶體裡，時間、session、git、gh 都給固定值；回傳開過的面板 id，照開的順序
const stubEngine = (on: On, clock: { now: number }, files: Map<string, string>, isPanePlaced = true) => {
  const opens: string[] = []
  on('ui.open', ($, e) => {
    opens.push(e.id)
    return { value: isPanePlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: '放不下' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 9.99 } } }))
  on('clock.now', () => ({ value: clock.now }))
  on('process.run', ($, e) => {
    const branch = e.argv[0] === 'gh' ? 'feat/ledger' : e.init?.cwd === '/wt/100' ? 'fix/draft-routes' : 'dev'
    return { value: { exitCode: 0, stdout: `${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some((p) => p.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const entries = new Map<string, 'file' | 'dir'>()
    for (const p of files.keys()) {
      if (!p.startsWith(prefix)) continue
      const [head = '', ...rest] = p.slice(prefix.length).split('/')
      entries.set(head, rest.length > 0 ? 'dir' : 'file')
    }
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  // 每一步等 2 秒才有第一個片段，再花 20 秒產完輸出。turnId 帶 big 的那一步輸出加倍、10 秒就產完：
  // 兩段工作的金額分得出來，兩筆的速度也不一樣（50 與 200 tok/s）
  on('turn.step', async function* ($, e) {
    const isBig = e.turnId.includes('big')
    const usage = isBig ? { ...USAGE, output_tokens: 2_000 } : USAGE
    clock.now += 2_000
    yield { kind: 'text' as const, index: 0, text: '好' }
    clock.now += isBig ? 10_000 : 20_000
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: e.turnId, index: e.index, answer: '好', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  // gh pr create 的輸出：指令帶 second 的開出 #102，其餘 #101
  on('tool.call', ($, e) => {
    const pr = 'command' in e && String(e.command).includes('second') ? 102 : 101
    return { result: { stdout: `https://github.com/example/app/pull/${pr}\n`, stderr: '', interrupted: false } }
  })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a2' }))
  // session 開始時註冊指令與工具、排定時寫帳；這裡不跑計時器
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__cost-ledger__${e.name}` } }))
  on('clock.every', () => ({ value: undefined }))
  // 輸入框上方那一格引擎自己什麼都不畫
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  return { opens }
}

const step = async ($: Engine, turnId: string, agentId?: string) => {
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 3, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of stream) {
    // 讀到底，讓 turn.step 跑完
  }
  await stream.result
}

// 子 agent 發的 Bash 帶它的 agentId；呼叫的型別沒列這個欄位，引擎照收，所以先放進變數再傳
const bash = async ($: Engine, command: string, agentId: string) => {
  const input = { tool: 'Bash' as const, command, agentId }
  await $.tool.call(input)
}

// 模型查帳用的工具，回 markdown
const ledgerTool = async ($: Engine, pr?: number): Promise<string> => {
  const tool = 'mcp__cost-ledger__ledger' as const
  const ran = await $.tool.call(pr === undefined ? { tool } : { tool, pr })
  return String(ran.result)
}

// origin 與 presentation 由引擎蓋章（官方範例也只給 command 和 args），型別上補一個斷言
const ledger = ($: Engine, args: string) => $.command.run({ command: 'ledger', args } as CommandRunInput)

const PANE_PROPS = {
  title: '花費',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'cost-ledger', surface, component: 'Pane', requestId: 'cost-ledger', props: PANE_PROPS })

const CARD_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const mountCard = ($: Engine, surface: 'terminal' | 'desktop', hasSurvey = false, bodyColumns = CARD_PROPS.bodyColumns) =>
  $.ui.mount({ plugin: 'cost-ledger', surface, component: 'AbovePrompt', props: { ...CARD_PROPS, hasSurvey, bodyColumns } })

const cardLabel = async (card: Awaited<ReturnType<typeof mountCard>>) =>
  String((await card.find({ key: 'open-pane' }))?.props.label)

const startSession = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

test('主對話的請求照 1 小時快取拆價寫進帳本，查帳照 token 種類列出來', async ($, on) => {
  const clock = { now: Date.UTC(2026, 9, 4, 1, 0, 0) }
  const files = new Map<string, string>()
  stubEngine(on, clock, files)

  await step($, 't1')

  const answer = await ledgerTool($)
  // 輸入 10×4 + 輸出 1,000×20 + 1 小時寫入 20,000×8 + 讀取 100,000×0.2，除以一百萬 = $0.20004
  expect(answer).toContain('共 **$0.20**')
  expect(answer).toContain('| 快取寫入（1 小時） | $0.16 | 80.0% |')
  expect(answer).toContain('依歸屬：分支 dev $0.20')
  expect(answer).toContain('Claude Code 自己記的這個 session 累計 $9.99')

  const row = JSON.parse((files.get('/home/t/.claude/cost-ledger/2026-10-04/s1.jsonl') ?? '').trim())
  expect(row.kind).toBe('request')
  expect(row.cacheTtl).toBe('1h')
  expect(row.tokens).toEqual({ input: 10, output: 1_000, cacheRead: 100_000, cacheWrite: 20_000 })
  expect(row.contextTokens).toBe(120_010)
  expect(row.timing).toEqual({ ttftMs: 2_000, genMs: 20_000 })
})

test('輸出速度只算生成的那段，平均是總輸出除以總生成時間，加上計時之前記的舊列不算進速度', async ($, on) => {
  const clock = { now: Date.UTC(2026, 9, 4, 7, 0, 0) }
  const files = new Map<string, string>()
  // 加上計時之前記的一列：輸出 5,000 token、沒有 timing 這一欄，金額照算
  const old = {
    v: 1,
    kind: 'request',
    ts: '2026-10-04T06:00:00.000Z',
    session: 's1',
    agentId: null,
    turnId: 't0',
    step: 0,
    model: 'claude-opus-5-5',
    requestedModel: 'claude-opus-5-5',
    effort: null,
    messageCount: 1,
    stopReason: 'end_turn',
    tokens: { input: 0, output: 5_000, cacheRead: 0, cacheWrite: 0 },
    contextTokens: 0,
    cacheTtl: '1h',
    ttlSource: 'assumed',
    priceTable: '2026-09-25',
    prices: null,
    costUsd: { input: 0, output: 0.1, cacheWrite: 0, cacheRead: 0, total: 0.1 },
    branch: 'dev',
    engineCostUsd: null,
  }
  files.set('/home/t/.claude/cost-ledger/2026-10-04/s1.jsonl', `${JSON.stringify(old)}\n`)
  stubEngine(on, clock, files)
  await startSession($)

  // 1,000 token 花 20 秒是 50 tok/s，接著 2,000 token 花 10 秒是 200 tok/s
  await step($, 't1')
  await step($, 't2-big')

  // 平均 3,000 ÷ 30 秒 = 100。等第一個片段的 4 秒算進去會是 88，兩筆直接平均會是 125，舊列的輸出算進去會更高
  const answer = await ledgerTool($)
  expect(answer).toContain('依模型：claude-opus-5-5 $0.52（100 tok/s）')
  expect(answer).toContain('輸出速度平均 100 tok/s。')

  for (const surface of ['terminal', 'desktop'] as const) {
    const card = await mountCard($, surface)
    expect(await cardLabel(card)).toBe('花費 $0.52 · 輸出 200 tok/s（平均 100）  詳細 ›')
    await card.unmount()

    const pane = await mountPane($, surface)
    expect(await pane.find({ text: '輸出速度：最近 200 tok/s · 平均 100 tok/s' })).toBeDefined()
    expect(await pane.find({ text: '$0.20 · 120k · 50 tok/s' })).toBeDefined()
    // 舊列在最近的請求裡照列金額，沒有速度
    expect(await pane.find({ text: '$0.10 · 0k' })).toBeDefined()
    await pane.unmount()
  }
})

test('輸入框上方的卡片：沒有請求不佔位、有問卷就讓開，按了把面板開在這個 session；session 開始時不自己開面板', async ($, on) => {
  const clock = { now: Date.UTC(2026, 9, 4, 8, 0, 0) }
  const { opens } = stubEngine(on, clock, new Map())
  await startSession($)
  expect(opens).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const card = await mountCard($, surface)
    expect(await card.find({ key: 'open-pane' })).toBeUndefined()
    await card.unmount()
  }

  await step($, 't1')
  // 先把面板切去看 PR，按卡片要切回這個 session
  await ledger($, 'pr 101')
  opens.length = 0

  for (const surface of ['terminal', 'desktop'] as const) {
    const busy = await mountCard($, surface, true)
    expect(await busy.find({ key: 'open-pane' })).toBeUndefined()
    await busy.unmount()

    const card = await mountCard($, surface)
    expect(await cardLabel(card)).toBe('花費 $0.20 · 輸出 50 tok/s（平均 50）  詳細 ›')
    // 卡片只佔一行：按鈕和長條橫排
    expect((await card.find({ key: 'card' }))?.props.flexDirection).toBe('row')
    if (surface === 'terminal') {
      // 字元長條塞在按鈕右邊，總長 20 格（按鈕那行佔 45 格，寬 80 放得下）；未快取的輸入分不到一格就不畫
      const cells = (await card.findAll({ type: 'Text', text: /^[█▒]+$/ })).map((t) => t.text)
      expect(cells.join('')).toHaveLength(20)
      expect(cells).toHaveLength(3)

      // 寬 50 扣掉按鈕只剩 4 格，不畫長條，也不折成第二行
      const narrow = await mountCard($, surface, false, 50)
      expect(await narrow.findAll({ type: 'Text', text: /^[█▒]+$/ })).toHaveLength(0)
      expect(await narrow.find({ key: 'open-pane' })).toBeDefined()
      await narrow.unmount()
    } else {
      expect(String((await card.find({ type: 'Svg' }))?.props.source)).toContain('height="6"')
    }

    await card.press({ key: 'open-pane' })
    expect(opens).toEqual(['cost-ledger'])
    opens.length = 0
    await card.unmount()

    const pane = await mountPane($, surface)
    expect(await pane.find({ text: '這個 session　$0.20' })).toBeDefined()
    await pane.unmount()
  }
})

test('子 agent 的快取寫入照 5 分鐘算，每段工作歸給它之後開的那支 PR', async ($, on) => {
  const clock = { now: Date.UTC(2026, 9, 4, 2, 0, 0) }
  const files = new Map<string, string>()
  stubEngine(on, clock, files)

  // 同一個子 agent 依序做兩張：先做一段、開 #101，再做一段輸出較多的、開 #102
  await step($, 't2', 'a1')
  clock.now += 60_000
  await bash($, 'gh pr create --title "first"', 'a1')
  clock.now += 60_000
  await step($, 't3-big', 'a1')
  clock.now += 60_000
  await bash($, 'gh pr create --title "second"', 'a1')

  // 第一段：5 分鐘寫入 20,000×5 = $0.10，整筆 $0.14004
  const first = await ledgerTool($, 101)
  expect(first).toContain('**cost-ledger｜PR #101**')
  expect(first).toContain('1 個 session、1 次請求，共 **$0.14**')
  expect(first).toContain('| 快取寫入（5 分鐘） | $0.10 |')

  // 第二段：輸出 2,000×20 = $0.04，整筆 $0.16004
  const second = await ledgerTool($, 102)
  expect(second).toContain('1 個 session、1 次請求，共 **$0.16**')
})

test('派出時指定了目錄的子 agent，沒有 PR 證據時到它自己的目錄查分支，來源標上任務說明', async ($, on) => {
  const clock = { now: Date.UTC(2026, 9, 4, 3, 0, 0) }
  const files = new Map<string, string>()
  stubEngine(on, clock, files)

  // 引擎派出子 agent 時要的其餘欄位跟這支測試無關，型別上補一個斷言
  await $.agent.spawn({ description: '#100 draft routes', subagentType: 'general-purpose', cwd: '/wt/100' } as AgentSpawnInput)
  await step($, 't4', 'a2')

  const answer = await ledgerTool($)
  expect(answer).toContain('依來源：#100 draft routes $0.14')
  expect(answer).toContain('依歸屬：分支 fix/draft-routes $0.14')
})

test('面板跟著每次請求即時更新，桌面版與終端機都畫得出來，複製出去的是同一份 markdown', async ($, on) => {
  const clock = { now: Date.UTC(2026, 9, 4, 4, 0, 0) }
  const files = new Map<string, string>()
  stubEngine(on, clock, files)
  let copied = ''
  on('ui.copy', ($, e) => {
    copied = e.text
    return { value: { isCopied: true as const } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /還沒有紀錄/ })).toBeDefined()
    await ui.unmount()
  }

  await step($, 't5')

  // 兩邊同時開著，下一次請求進來都直接變
  const panes = [await mountPane($, 'terminal'), await mountPane($, 'desktop')]
  for (const ui of panes) {
    expect(await ui.find({ text: '這個 session　$0.20' })).toBeDefined()
    expect(await ui.find({ text: /^快取寫入（1 小時）/ })).toBeDefined()
    expect(await ui.find({ text: '$0.16  80.0%' })).toBeDefined()
    expect(await ui.find({ text: '主對話 · opus-5-5' })).toBeDefined()
    expect(await ui.find({ text: '分支 dev' })).toBeDefined()
  }

  // 桌面版是一條堆疊長條加每項一個色塊，終端機沒有 Svg、照舊畫字元長條。
  // 未快取的輸入只佔萬分之二，長條上不畫、圖例照列；畫出來的三段照固定順序上色
  const [terminal, desktop] = panes
  expect(await terminal?.find({ type: 'Svg' })).toBeUndefined()
  // 快取寫入佔 80%：36 格的長條畫滿 29 格
  expect(await terminal?.find({ text: '█'.repeat(29) })).toBeDefined()
  // 長條是第一個 Svg，其後是圖例的色塊
  const bar = String((await desktop?.find({ type: 'Svg' }))?.props.source)
  expect([...bar.matchAll(/<rect x="[^"]+" y="\d+" width="[^"]+" height="\d+" fill="([^"]+)"/g)].map((m) => m[1])).toEqual([
    '#3987e5',
    '#d95926',
    '#199e70',
  ])
  expect(await desktop?.findAll({ type: 'Svg' })).toHaveLength(5)

  clock.now += 60_000
  await step($, 't6')

  for (const ui of panes) {
    expect(await ui.find({ text: '這個 session　$0.40' })).toBeDefined()
    copied = ''
    await ui.press({ key: 'copy' })
    expect(copied).toContain('**cost-ledger｜這個 session**')
    expect(copied).toContain('2 次請求，共 **$0.40**')
    await ui.unmount()
  }
})

test('放不下面板的地方，/ledger 照舊把表印在對話裡', async ($, on) => {
  const clock = { now: Date.UTC(2026, 9, 4, 6, 0, 0) }
  stubEngine(on, clock, new Map(), false)

  await step($, 't9')

  const answer = await ledger($, '')
  expect(answer.text).toContain('**cost-ledger｜這個 session**')
  expect(answer.text).toContain('共 **$0.20**')
})

test('/ledger pr <編號> 把面板切到那支 PR，分頁切得回這個 session', async ($, on) => {
  const clock = { now: Date.UTC(2026, 9, 4, 5, 0, 0) }
  const files = new Map<string, string>()
  stubEngine(on, clock, files)

  await step($, 't7', 'a1')
  clock.now += 60_000
  await bash($, 'gh pr create --title "first"', 'a1')
  clock.now += 60_000
  await step($, 't8')

  const answer = await ledger($, 'pr 101')
  // 面板放得下就不在對話裡印表
  expect(answer.text).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: 'PR #101　$0.14' })).toBeDefined()
    expect(await ui.find({ key: 'refresh-pr' })).toBeDefined()

    await ui.press({ key: 'tab-session' })
    expect(await ui.find({ text: '這個 session　$0.34' })).toBeDefined()
    expect(await ui.find({ key: 'refresh-pr' })).toBeUndefined()
    if (surface === 'desktop') {
      // 子 agent 的 5 分鐘寫入跟主對話的 1 小時寫入同一個橘，5 分鐘那段靠斜紋分開
      const bar = String((await ui.find({ type: 'Svg' }))?.props.source)
      expect(bar).toContain('fill="url(#hatch)"')
      expect(bar).toContain('<pattern id="hatch"')
    }

    await ui.press({ key: 'tab-pr' })
    expect(await ui.find({ text: 'PR #101　$0.14' })).toBeDefined()
    await ui.unmount()
  }
})
