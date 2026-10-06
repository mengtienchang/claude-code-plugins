import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { CommandRunInput, On, PromptComposeInput, SessionEndInput, ToolCheckArgs, ToolDescribeInput, TurnCompleteInput } from 'claude-code'

import type { HistoryEntry } from '../types'

const TOOL = 'mcp__task-progress__estimate' as const
// 秒數是 8 的倍數：轉圈從 ◐ 開始，沒有預估時跑的那一段從最左邊開始
const START = Date.UTC(2026, 9, 6, 1, 0, 0)

// 站在引擎那一側：時間、store 放在記憶體裡，session 的累計花費由測試撥。回傳時鐘、開過的面板 id 與 store 裡的紀錄
const stubEngine = (on: On, cost: { usd: number | null }, options: { isPanePlaced?: boolean; history?: HistoryEntry[] } = {}) => {
  const clock = mock.clock(on, { now: START })
  const store = new Map<string, unknown>([['history', options.history ?? []]])
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  const opens: string[] = []
  on('ui.open', ($, e) => {
    opens.push(e.id)
    return { value: options.isPanePlaced === false ? { isPlaced: false as const, reason: '放不下' } : { isPlaced: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: START, context: { window: 1_000_000 }, rateLimits: [], ...(cost.usd === null ? {} : { cost: { usd: cost.usd } }) },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__task-progress__${e.name}` } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // 其他工具照常跑完；Bash 要 5 秒，看得到「正在跑」
  on('tool.call', async ($, e) => {
    if (e.tool === 'Bash') await clock.sleep(5_000)
    return { result: 'ok' }
  })
  on('tool.describe', ($, e) => ({ description: e.description, isDeferred: true }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: '你是 Claude。', scope: 'shared' as const }] }))
  // 輸入框上方那一格：別的插件（像 cost-ledger）畫的一行
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({ key: 'below', children: Text({ children: '花費 $1.00' }) })
  })
  const stored = () => (store.get('history') ?? []) as HistoryEntry[]
  return { clock, opens, stored }
}

const startSession = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

const estimate = async ($: Engine, toolCalls: number, costUsd: number, summary = '修登入頁的錯', agentId?: string) => {
  const input = { tool: TOOL, toolCalls, costUsd, summary, ...(agentId ? { agentId } : {}) }
  return String((await $.tool.call(input)).result)
}

// 主對話（或子 agent）讀一個檔；呼叫的型別沒列 agentId，引擎照收，所以先放進變數再傳
const readFile = async ($: Engine, clock: MockClock, file: string, agentId?: string) => {
  const input = { tool: 'Read' as const, file_path: `/repo/src/${file}`, ...(agentId ? { agentId } : {}) }
  await $.tool.call(input)
  await clock.settle()
}

// 引擎蓋章的其餘欄位跟這些測試無關，型別上補一個斷言
const complete = ($: Engine, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer: '', durationMs: 0, isAborted: reason === 'aborted', turnId: 't', reason } as TurnCompleteInput)

const CARD_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const mountCard = ($: Engine, surface: 'terminal' | 'desktop', props: Partial<typeof CARD_PROPS> = {}) =>
  $.ui.mount({ plugin: 'task-progress', surface, component: 'AbovePrompt', props: { ...CARD_PROPS, ...props } })

const cardLabel = async ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') => {
  const card = await mountCard($, surface)
  const label = (await card.find({ key: 'open-progress' }))?.props.label
  await card.unmount()
  return label === undefined ? undefined : String(label)
}

const PANE_PROPS = {
  title: '進度',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
}

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'task-progress', surface, component: 'Pane', requestId: 'task-progress', props: PANE_PROPS })

const entry = (id: string, estimate: [number, number], actual: [number, number], status: HistoryEntry['status'] = 'done'): HistoryEntry => ({
  id,
  endedAt: START - 60_000,
  title: id,
  status,
  estimate: { toolCalls: estimate[0], costUsd: estimate[1] },
  revised: null,
  actual: { toolCalls: actual[0], costUsd: actual[1], durationMs: 60_000 },
})

test('Claude 宣告預估之後，卡片照工具次數與花費的平均算百分比，經過時間每秒跳；做完記一筆紀錄', async ($, on) => {
  const cost = { usd: 5 }
  const { clock, stored } = stubEngine(on, cost)
  await startSession($)

  await $.turn.start({ text: '幫我修登入頁\n按了沒反應', turnId: 't1' })
  // 還沒宣告預估、也還沒動工具：只顯示在想，不畫百分比
  expect(await cardLabel($)).toBe('◐ 思考中 · 工具 0 · $0.00 · 0:00  詳細 ›')

  expect(await estimate($, 10, 2)).toBe('已記下預估：工具 10 次、$2.00。進度條在使用者的輸入框上方。')
  await readFile($, clock, 'login.tsx')
  await readFile($, clock, 'auth.ts')
  cost.usd = 6
  // 工具 2/10 = 20%，花費 $1/$2 = 50%，平均 35%；一秒後轉圈換一格，花費也在這時跟上
  await clock.advance(1_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await cardLabel($, surface)).toBe('◓ 35% · 工具 2/10 · $1.00/$2.00 · 0:01  詳細 ›')
  }

  // 第 20 秒：照目前的速度推剩下的時間，20 秒 × 65 / 35 ≈ 37 秒
  await clock.advance(19_000)
  expect(await cardLabel($)).toBe('◐ 35% · 工具 2/10 · $1.00/$2.00 · 0:20 · 約剩 0:37  詳細 ›')

  cost.usd = 7.2
  await complete($)
  expect(await cardLabel($)).toBe('✓ 完成 · 工具 2/10 · $2.20/$2.00 · 0:20  詳細 ›')

  expect(stored()).toHaveLength(1)
  const [first] = stored()
  expect(first?.title).toBe('修登入頁的錯')
  expect(first?.estimate).toEqual({ toolCalls: 10, costUsd: 2 })
  expect(first?.actual.toolCalls).toBe(2)
  expect(Math.round((first?.actual.costUsd ?? 0) * 100)).toBe(220)
  expect(first?.actual.durationMs).toBe(20_000)

  // 做完就不再每秒更新
  await clock.advance(5_000)
  expect(await cardLabel($)).toBe('✓ 完成 · 工具 2/10 · $2.20/$2.00 · 0:20  詳細 ›')
})

test('正在跑的工具接在卡片最後、列在面板的「正在跑」；跑完移到「剛跑完」並記下花了多久', async ($, on) => {
  const { clock } = stubEngine(on, { usd: 0 })
  await startSession($)

  await $.turn.start({ text: '跑測試', turnId: 't1' })
  await estimate($, 4, 1, '跑測試')
  const running = $.tool.call({ tool: 'Bash', command: 'npm test', description: '跑全部的測試' })
  await clock.settle()
  expect(await cardLabel($)).toBe('◐ 0% · 工具 0/4 · $0.00/$1.00 · 0:00 · Bash · 跑全部的測試  詳細 ›')
  const busy = await mountPane($, 'terminal')
  expect(await busy.find({ text: '◐ Bash · 跑全部的測試' })).toBeDefined()
  await busy.unmount()

  await clock.advance(5_000)
  await running
  expect(await cardLabel($)).toBe('◓ 13% · 工具 1/4 · $0.00/$1.00 · 0:05 · 約剩 0:35  詳細 ›')
  const pane = await mountPane($, 'desktop')
  expect(await pane.find({ text: '✓ Bash · 跑全部的測試' })).toBeDefined()
  expect(await pane.find({ text: '5.0s' })).toBeDefined()
  await pane.unmount()
})

test('滿三筆紀錄就把下一次的預估乘上「實際 ÷ 預估」的中位數；Claude 改過預估就直接用它的數字', async ($, on) => {
  // 工具實際分別是預估的 2、1.5、3 倍，中位數 2；花費 1.5、1、2 倍，中位數 1.5。中斷的那筆不算
  const { stored } = stubEngine(
    on,
    { usd: 0 },
    {
      history: [
        entry('a', [10, 1], [20, 1.5]),
        entry('b', [10, 1], [15, 1]),
        entry('c', [10, 1], [30, 2]),
        entry('d', [10, 1], [1, 0.1], 'aborted'),
      ],
    },
  )
  await startSession($)

  await $.turn.start({ text: '加一個匯出按鈕', turnId: 't1' })
  await estimate($, 6, 0.8, '加匯出按鈕')
  expect(await cardLabel($)).toBe('◐ 0% · 工具 0/12 · $0.00/$1.20 · 0:00  詳細 ›')

  const pane = await mountPane($, 'desktop')
  expect(await pane.find({ text: 'Claude 預估工具 6 次、$0.80；依過去紀錄校正：工具 ×2.00、花費 ×1.50' })).toBeDefined()
  expect(await pane.find({ text: /^最近 3 筆做完的任務，實際 ÷ 預估的中位數：工具 ×2.00 · 花費 ×1.50/ })).toBeDefined()
  await pane.unmount()

  // 做到一半 Claude 發現範圍變大，改成 20 次、$3：照它的數字，不再乘倍率
  expect(await estimate($, 20, 3)).toBe('已更新預估：工具 20 次、$3.00。進度條在使用者的輸入框上方。')
  expect(await cardLabel($)).toBe('◐ 0% · 工具 0/20 · $0.00/$3.00 · 0:00  詳細 ›')

  await complete($)
  // 紀錄留第一次的宣告（校正照這個算），修正的另外記
  expect(stored()).toHaveLength(5)
  expect(stored()[0]?.estimate).toEqual({ toolCalls: 6, costUsd: 0.8 })
  expect(stored()[0]?.revised).toEqual({ toolCalls: 20, costUsd: 3 })
})

test('超出預估時照實際的比例顯示、長條換色；子 agent 的工具另外數，它呼叫 estimate 不算數', async ($, on) => {
  const cost = { usd: 0 }
  const { clock } = stubEngine(on, cost)
  await startSession($)

  await $.turn.start({ text: '重構', turnId: 't1' })
  await estimate($, 2, 1)
  expect(await estimate($, 99, 9, '子 agent 自己估', 'a1')).toBe('子 agent 不用宣告預估，進度只算主對話。')
  await readFile($, clock, 'a.ts', 'a1')
  await readFile($, clock, 'b.ts', 'a1')
  for (const file of ['a.ts', 'b.ts', 'c.ts']) await readFile($, clock, file)
  cost.usd = 2
  await clock.advance(1_000)

  // 工具 3/2 = 150%，花費 $2/$1 = 200%，平均 175%
  expect(await cardLabel($)).toBe('◓ 超出預估 175% · 工具 3/2 · $2.00/$1.00 · 0:01  詳細 ›')
  const card = await mountCard($, 'desktop')
  expect(String((await card.find({ type: 'Svg' }))?.props.source)).toContain('fill="#d95926"')
  await card.unmount()

  const pane = await mountPane($, 'terminal')
  expect(await pane.find({ text: '子 agent 呼叫了 2 次工具（不算進工具次數，花費有算）' })).toBeDefined()
  expect(await pane.find({ text: '✓ Read · c.ts' })).toBeDefined()
  await pane.unmount()
})

test('卡片接在別的插件那一行上面；有問卷就讓開，沒有任務、或做完沒動過工具的不佔位', async ($, on) => {
  const { clock, opens } = stubEngine(on, { usd: 0 })
  await startSession($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await mountCard($, surface)
    expect(await idle.find({ key: 'open-progress' })).toBeUndefined()
    expect(await idle.find({ key: 'below' })).toBeDefined()
    await idle.unmount()
  }

  // 只是聊天：進行中照樣顯示在想，做完就收起來
  await $.turn.start({ text: '早安', turnId: 't0' })
  expect(await cardLabel($)).toBe('◐ 思考中 · 工具 0 · $0.00 · 0:00  詳細 ›')
  await complete($)
  expect(await cardLabel($)).toBeUndefined()

  await $.turn.start({ text: '跑測試', turnId: 't1' })
  await readFile($, clock, 'a.test.ts')
  for (const surface of ['terminal', 'desktop'] as const) {
    const survey = await mountCard($, surface, { hasSurvey: true })
    expect(await survey.find({ key: 'open-progress' })).toBeUndefined()
    await survey.unmount()

    const card = await mountCard($, surface)
    expect(String((await card.find({ key: 'open-progress' }))?.props.label)).toBe('◐ 進行中 · 工具 1 · $0.00 · 0:00 · 還沒有預估  詳細 ›')
    expect(await card.find({ key: 'below' })).toBeDefined()
    if (surface === 'terminal') {
      // 沒有預估時長條是來回跑的一小段：12 格裡亮 3 格，這一秒在最左邊
      expect((await card.findAll({ type: 'Text', text: /^[█░]+$/ })).map((t) => t.text)).toEqual(['███', '░'.repeat(9)])
    }
    await card.press({ key: 'open-progress' })
    expect(opens).toEqual(['task-progress'])
    opens.length = 0
    await card.unmount()
  }

  // 那一小段每秒往右一格
  await clock.advance(2_000)
  const moved = await mountCard($, 'terminal')
  expect((await moved.findAll({ type: 'Text', text: /^[█░]+$/ })).map((t) => t.text)).toEqual(['░░', '███', '░'.repeat(7)])
  await moved.unmount()

  // 終端機太窄放不下長條：只留文字，不折行
  const narrow = await mountCard($, 'terminal', { bodyColumns: 50 })
  expect(await narrow.find({ type: 'Text', text: /█/ })).toBeUndefined()
  expect(await narrow.find({ key: 'open-progress' })).toBeDefined()
  await narrow.unmount()
})

test('背景工作做完接著跑的那一輪算回同一個任務；中斷的照記但不拿來校正；/clear 之後卡片收起來', async ($, on) => {
  const { clock, stored } = stubEngine(on, { usd: 0 })
  await startSession($)

  await $.turn.start({ text: '派 agent 去查', turnId: 't1' })
  await estimate($, 4, 1, '查舊 API 的呼叫點')
  await readFile($, clock, 'a.ts')
  await complete($)
  await clock.advance(30_000)

  // 引擎自己接著跑的那一輪沒有打字；工具 2/4 = 50%、花費 0，平均 25%，30 秒 × 75 / 25 = 90 秒
  await $.turn.start({ text: '', turnId: 't2' })
  await readFile($, clock, 'b.ts')
  expect(await cardLabel($)).toBe('◑ 25% · 工具 2/4 · $0.00/$1.00 · 0:30 · 約剩 1:30  詳細 ›')
  await complete($, 'aborted')
  expect(await cardLabel($)).toBe('■ 中斷 · 工具 2/4 · $0.00/$1.00 · 0:30  詳細 ›')

  // 同一個任務只有一筆，照最後的狀態
  expect(stored()).toHaveLength(1)
  expect(stored()[0]?.status).toBe('aborted')
  expect(stored()[0]?.actual.toolCalls).toBe(2)

  const pane = await mountPane($, 'desktop')
  expect(await pane.find({ text: '做完的有預估任務 0 筆，滿 3 筆才開始校正。' })).toBeDefined()
  expect(await pane.find({ text: '■ 查舊 API 的呼叫點' })).toBeDefined()
  await pane.unmount()

  await $.session.end({ reason: 'clear', sessionId: 's1' } as SessionEndInput)
  expect(await cardLabel($)).toBeUndefined()
})

test('estimate 一開始就放進工具清單、不用問權限；系統提示加上固定的一段，沒有這個工具時不加', async ($, on) => {
  stubEngine(on, { usd: 0 })
  await startSession($)

  const described = await $.tool.describe({
    tool: TOOL,
    description: '宣告預估',
    isDeferred: true,
    provider: { plugin: 'task-progress', tier: 'user' },
  } as ToolDescribeInput)
  expect(described.isDeferred).toBe(false)
  expect((await $.tool.check({ tool: TOOL } as ToolCheckArgs)).decision).toBe('allow')

  const compose = (tools: string[]) =>
    $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools, outputStyle: null, traits: [] } as PromptComposeInput)
  const composed = await compose(['Read', TOOL])
  expect(composed.sections.map((s) => s.id)).toEqual(['intro', 'task-progress:estimate'])
  expect(composed.sections[1]?.scope).toBe('session')
  expect(composed.sections[1]?.text).toContain(`先呼叫 ${TOOL}`)

  expect((await compose(['Read'])).sections.map((s) => s.id)).toEqual(['intro'])
})

test('宿主沒有花費帳時只看工具次數；放不下面板的地方 /progress 把狀態印在對話裡', async ($, on) => {
  const { clock } = stubEngine(on, { usd: null }, { isPanePlaced: false })
  await startSession($)

  await $.turn.start({ text: '改 README', turnId: 't1' })
  await estimate($, 4, 0.5, '改 README')
  await readFile($, clock, 'README.md')
  expect(await cardLabel($)).toBe('◐ 25% · 工具 1/4 · 0:00  詳細 ›')

  const answer = await $.command.run({ command: 'progress', args: '' } as CommandRunInput)
  expect(answer.text).toContain('**task-progress**')
  expect(answer.text).toContain('◐ 25% · 工具 1/4 · 0:00')
  expect(answer.text).toContain('Claude 預估：工具 4 次、$0.50')
})
