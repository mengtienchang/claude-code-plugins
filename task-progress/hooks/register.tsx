import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Declared, Estimate, HistoryEntry, RecentTool, Task, TaskStatus } from '../types'

// ---- Claude 宣告預估用的工具 ----
const TOOL = 'mcp__task-progress__estimate'
const PANE = 'task-progress'
const PANE_TITLE = '進度'

// 系統提示裡固定的一段。內容不跟著紀錄變，prompt cache 才不會每輪失效；
// 校正倍率也不告訴 Claude，插件自己乘：Claude 跟著調的話，倍率會被重複修正
const INSTRUCTIONS = [
  '# 任務進度（task-progress 插件）',
  '使用者在輸入框上方看一條進度條，百分比照你一開始給的預估算：已經呼叫的工具次數與已經花的錢，各自除以預估再平均。',
  `- 收到要動用工具的任務（預計超過兩次工具呼叫）時，在其他工具呼叫之前先呼叫 ${TOOL}，給整個任務預計的工具呼叫總次數與總花費。`,
  '- 工具次數只算主對話自己的呼叫：派一個子 agent 算一次，它在裡面呼叫的不算；estimate 本身也不算。花費算整個任務，子 agent 的也算，照 API 價格估美元。',
  '- 只是回答問題、聊天，或一兩次工具就做完的，不用呼叫。你是被派出去的子 agent 的話也不用。',
  '- 做到一半發現範圍明顯變了（已經超過預估、或會比預估少很多），再呼叫一次給新的總數（從任務開始算起，含已經做的），reason 寫為什麼。',
  '- 照實際判斷估，不要為了讓進度好看而灌水或壓低；插件會拿過去的紀錄自己校正偏差。',
].join('\n')

// ---- 校正 ----
// 最近 WINDOW 筆做完的任務，實際 ÷ 第一次預估取中位數；滿 MIN_SAMPLES 筆才套用。
// 中位數不會被一兩筆離譜的任務帶走；倍率夾在 1/4 到 4 倍之間，免得一筆 0 次工具的任務把分母壓到 0
const WINDOW = 20
const MIN_SAMPLES = 3
const MAX_HISTORY = 100
const clampFactor = (x: number) => Math.min(4, Math.max(0.25, x))

const median = (xs: number[]): number => {
  if (xs.length === 0) return 1
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 1) : ((sorted[mid - 1] ?? 1) + (sorted[mid] ?? 1)) / 2
}

type Calibration = { samples: number; factor: Declared }

// 中斷、出錯的任務沒做完，實際數字不代表那個任務的大小，不拿來算
const calibrationOf = (history: HistoryEntry[]): Calibration => {
  const usable = history
    .filter((h) => h.status === 'done' && h.estimate.toolCalls > 0 && h.estimate.costUsd > 0)
    .slice(0, WINDOW)
  const priced = usable.filter((h) => h.actual.costUsd !== null)
  return {
    samples: usable.length,
    factor: {
      toolCalls: clampFactor(median(usable.map((h) => h.actual.toolCalls / h.estimate.toolCalls))),
      costUsd: clampFactor(median(priced.map((h) => (h.actual.costUsd ?? 0) / h.estimate.costUsd))),
    },
  }
}

const scaled = (d: Declared, f: Declared): Declared => ({
  toolCalls: Math.max(1, Math.round(d.toolCalls * f.toolCalls)),
  costUsd: d.costUsd * f.costUsd,
})

// ---- 進度 ----
// 工具次數與花費各自除以分母再平均；宿主沒有花費帳時只看工具次數。可能超過 1（超出預估）
const shareOf = (t: Task): number | null => {
  if (t.estimate === null) return null
  const { target } = t.estimate
  const parts = [t.toolCalls / Math.max(1, target.toolCalls)]
  if (t.costUsd !== null && target.costUsd > 0) parts.push(t.costUsd / target.costUsd)
  return parts.reduce((a, b) => a + b, 0) / parts.length
}

const elapsedOf = (t: Task, now: number) => Math.max(0, (t.endedAt ?? now) - t.startedAt)

// 照目前的速度推剩下的時間；開始不到 5 秒、或做不到 5% 時推出來的數字太跳，不顯示
const remainingOf = (t: Task, now: number): number | null => {
  const share = shareOf(t)
  const elapsed = elapsedOf(t, now)
  if (t.status !== 'running' || share === null || share < 0.05 || share >= 1 || elapsed < 5_000) return null
  return (elapsed * (1 - share)) / share
}

// ---- 狀態 ----
// 畫面讀的值放 $.state：熱重載時模組變數會清空，這些留著；紀錄另外寫進 $.store，跨 session 留著
const taskAtom = atom({ plugin: 'task-progress', key: 'task' } as const, null as Task | null)
const nowAtom = atom({ plugin: 'task-progress', key: 'now' } as const, 0)
const historyAtom = atom({ plugin: 'task-progress', key: 'history' } as const, [] as HistoryEntry[])

const HISTORY_KEY = 'history'

const storedHistory = async ($: EngineInterface): Promise<HistoryEntry[]> => {
  const stored = await $.store.get(HISTORY_KEY)
  return Array.isArray(stored) ? (stored as HistoryEntry[]) : []
}

// 宿主沒有花費帳（cost 不在）時是 null
const sessionCost = async ($: EngineInterface): Promise<number | null> => (await $.session.usage()).cost?.usd ?? null

const costSince = (t: Task, cost: number | null): number | null =>
  t.costAtStart === null || cost === null ? t.costUsd : Math.max(0, cost - t.costAtStart)

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s)

const newTask = (id: string, prompt: string, now: number, cost: number | null): Task => ({
  id,
  prompt: clip(oneLine(prompt), 80),
  status: 'running',
  startedAt: now,
  endedAt: null,
  costAtStart: cost,
  costUsd: cost === null ? null : 0,
  toolCalls: 0,
  agentToolCalls: 0,
  running: [],
  recent: [],
  estimate: null,
})

async function startTask($: EngineInterface, id: string, prompt: string): Promise<void> {
  // 上一個還掛著（熱重載時錯過了它的結束）就當成中斷收掉
  if ((await read($, taskAtom))?.status === 'running') await finish($, 'aborted')
  const now = await $.clock.now()
  const cost = await sessionCost($)
  await update($, taskAtom, () => newTask(id, prompt, now, cost))
  await update($, nowAtom, () => now)
}

// 背景工作做完、引擎自己接著跑的那一輪沒有打字，算回上一個任務；經過時間照舊從那個任務開始算
async function resumeTask($: EngineInterface, id: string): Promise<void> {
  const last = await read($, taskAtom)
  if (last === null) return startTask($, id, '')
  const now = await $.clock.now()
  await update($, taskAtom, (t) => (t === null ? t : { ...t, status: 'running' as const, endedAt: null }))
  await update($, nowAtom, () => now)
}

async function finish($: EngineInterface, status: TaskStatus): Promise<void> {
  const now = await $.clock.now()
  const cost = await sessionCost($)
  await update($, taskAtom, (t) =>
    t === null || t.status !== 'running' ? t : { ...t, status, endedAt: now, running: [], costUsd: costSince(t, cost) },
  )
  await update($, nowAtom, () => now)
  const done = await read($, taskAtom)
  if (done?.estimate && done.status === status) await record($, done, done.estimate)
}

// 寫之前重讀一次 store：同時開著的別的 session 也在記，照 id 合併，不整份蓋掉
async function record($: EngineInterface, t: Task, estimate: Estimate): Promise<void> {
  const entry: HistoryEntry = {
    id: t.id,
    endedAt: t.endedAt ?? t.startedAt,
    title: estimate.summary || t.prompt,
    status: t.status,
    estimate: estimate.first,
    revised: estimate.revisions > 0 ? estimate.latest : null,
    actual: { toolCalls: t.toolCalls, costUsd: t.costUsd, durationMs: elapsedOf(t, t.endedAt ?? t.startedAt) },
  }
  const history = [entry, ...(await storedHistory($)).filter((h) => h.id !== entry.id)].slice(0, MAX_HISTORY)
  await $.store.set(HISTORY_KEY, history)
  await update($, historyAtom, () => history)
}

// 每秒一次：經過時間與轉圈靠它動，花費也在這裡跟上（session 的累計花費每次請求結束才變）
async function tick($: EngineInterface): Promise<void> {
  const t = await read($, taskAtom)
  if (t === null || t.status !== 'running') return
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  const cost = await sessionCost($)
  await update($, taskAtom, (cur) => {
    if (cur === null || cur.id !== t.id || cur.status !== 'running') return cur
    const costUsd = costSince(cur, cost)
    return costUsd === cur.costUsd ? cur : { ...cur, costUsd }
  })
}

// ---- 工具的說明 ----
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

// 卡片與面板上那一行「正在跑什麼」：工具名加上最能認出這次呼叫的那個參數
const labelOf = (input: Record<string, unknown>): string => {
  const tool = String(input.tool)
  const name = tool.startsWith('mcp__') ? (tool.split('__').slice(2).join('__') || tool) : tool
  const str = (k: string) => (typeof input[k] === 'string' && input[k] !== '' ? String(input[k]) : null)
  const path = str('file_path') ?? str('notebook_path') ?? str('path')
  const detail = str('description') ?? (path === null ? null : basename(path)) ?? str('pattern') ?? str('command') ?? str('url') ?? str('query') ?? str('skill')
  return detail === null ? name : `${name} · ${clip(oneLine(detail), 48)}`
}

// ---- 格式 ----
const usd = (x: number) => `$${x.toFixed(2)}`
const pctText = (x: number) => `${Math.round(x * 100)}%`
const two = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}
const times = (x: number) => `×${x.toFixed(2)}`
const SPINNER = ['◐', '◓', '◑', '◒']

// 終端機的顯示寬度：中日韓字與全形標點佔兩格，其餘一格
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
const columnsOf = (text: string) => [...text].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

type Tone = 'running' | 'over' | 'done' | 'stopped'

const COLORS: Record<Tone, string> = {
  running: '#3987e5',
  over: '#d95926',
  done: '#199e70',
  stopped: '#898781',
}
const TRACK = '#898781'

const toneOf = (t: Task): Tone => {
  if (t.status === 'done') return 'done'
  if (t.status !== 'running') return 'stopped'
  return (shareOf(t) ?? 0) >= 1 ? 'over' : 'running'
}

// 長條填多少：做完是滿的；進行中到不了 100%，超出預估時畫滿、換顏色；沒有預估是 null（畫來回跑的一小段）
const fillOf = (t: Task): number | null => {
  const share = shareOf(t)
  if (t.status === 'done') return 1
  if (share === null) return null
  return Math.min(1, share)
}

const headline = (t: Task, now: number): string => {
  const share = shareOf(t)
  const spin = SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? '◐'
  if (t.status === 'done') return '✓ 完成'
  if (t.status === 'aborted') return '■ 中斷'
  if (t.status === 'error') return '✕ 出錯'
  if (share === null) return `${spin} ${t.toolCalls === 0 && t.running.length === 0 ? '思考中' : '進行中'}`
  if (share >= 1) return `${spin} 超出預估 ${pctText(share)}`
  return `${spin} ${pctText(Math.min(share, 0.99))}`
}

const toolsText = (t: Task) => (t.estimate === null ? `工具 ${t.toolCalls}` : `工具 ${t.toolCalls}/${t.estimate.target.toolCalls}`)
const costText = (t: Task) => {
  if (t.costUsd === null) return null
  return t.estimate === null ? usd(t.costUsd) : `${usd(t.costUsd)}/${usd(t.estimate.target.costUsd)}`
}

// 卡片那一行的文字：狀態、工具次數、花費、經過時間、預估剩下的時間；正在跑的工具放最後，空間不夠先被切掉
const cardLine = (t: Task, now: number): string => {
  const remaining = remainingOf(t, now)
  const current = t.running[t.running.length - 1]
  return [
    headline(t, now),
    toolsText(t),
    costText(t),
    clock(elapsedOf(t, now)),
    remaining === null ? null : `約剩 ${clock(remaining)}`,
    t.status === 'running' && t.estimate === null && t.toolCalls > 0 ? '還沒有預估' : null,
    current === undefined ? null : current.label,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ')
}

// 對話裡印的版本：/progress 放不下面板時用
const format = (t: Task | null, history: HistoryEntry[], now: number): string => {
  const lines: string[] = ['**task-progress**']
  if (t === null) lines.push('還沒有任務。')
  else {
    lines.push(`${cardLine(t, now)}`)
    if (t.estimate) {
      const e = t.estimate
      lines.push(`Claude 預估：工具 ${e.latest.toolCalls} 次、${usd(e.latest.costUsd)}${e.revisions > 0 ? `（改過 ${e.revisions} 次）` : ''}`)
      if (e.factor) lines.push(`依過去紀錄校正：工具 ${times(e.factor.toolCalls)}、花費 ${times(e.factor.costUsd)}`)
    }
  }
  const c = calibrationOf(history)
  lines.push(
    c.samples >= MIN_SAMPLES
      ? `最近 ${c.samples} 筆做完的任務，實際 ÷ 預估的中位數：工具 ${times(c.factor.toolCalls)}、花費 ${times(c.factor.costUsd)}`
      : `做完的有預估任務 ${c.samples} 筆，滿 ${MIN_SAMPLES} 筆才開始校正。`,
  )
  return lines.join('\n')
}

// ---- 桌面版的圖 ----
// Svg 在桌面版畫成圖片、跟不到主題，顏色選淺色深色底上都看得清楚的；字一律交給 Text
const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

// 沒有預估時那一小段每秒往前一格，走到底再從頭
const RUNNER_SHARE = 0.25
const RUNNER_STEPS = 8
const runnerAt = (now: number) => (Math.floor(now / 1000) % RUNNER_STEPS) / RUNNER_STEPS

const progressSvg = (fill: number | null, tone: Tone, now: number, width: number, height: number): string => {
  const r = Math.min(4, height / 2)
  const track = `<rect width="${width}" height="${height}" rx="${r}" fill="${TRACK}" fill-opacity="0.3"/>`
  const [x, w] = fill === null ? [runnerAt(now) * width * (1 - RUNNER_SHARE), width * RUNNER_SHARE] : [0, fill * width]
  const bar = w <= 0 ? '' : `<rect x="${x.toFixed(2)}" width="${w.toFixed(2)}" height="${height}" rx="${r}" fill="${COLORS[tone]}"/>`
  return svg(width, height, track + bar)
}

// 終端機沒有 Svg，用字元畫：填滿的 █ 上色，剩下的 ░ 淡色
const progressCells = (fill: number | null, now: number, width: number): { before: number; filled: number; after: number } => {
  if (fill === null) {
    const filled = Math.max(1, Math.round(width * RUNNER_SHARE))
    const before = Math.round(runnerAt(now) * (width - filled))
    return { before, filled, after: width - before - filled }
  }
  const filled = Math.round(Math.max(0, Math.min(1, fill)) * width)
  return { before: 0, filled, after: width - filled }
}

type Cells = ReturnType<typeof progressCells>

// 字元長條的三段：前面空的、亮的（上色）、後面空的；長度 0 的段不畫
const cellSegments = (cells: Cells, tone: Tone) =>
  [
    { text: '░'.repeat(cells.before), color: null },
    { text: '█'.repeat(cells.filled), color: COLORS[tone] },
    { text: '░'.repeat(cells.after), color: null },
  ].filter((seg) => seg.text !== '')

const CARD_BAR_WIDTH = 120
const CARD_BAR_HEIGHT = 6
const CARD_BAR_CELLS = 12

// 面板只在使用者要看的時候開（/progress、按卡片），不在 session 開始時自己開
const openPane = async ($: EngineInterface) => (await $.ui.open({ id: PANE, title: PANE_TITLE })).isPlaced

// 卡片要不要佔位：進行中一律顯示（思考很久的時候也看得到在動）；做完的只在有預估或動過工具時留著
const isShown = (t: Task | null): t is Task => t !== null && (t.status === 'running' || t.estimate !== null || t.toolCalls > 0)

export const register: Register = (on) => {
  // 工具跑多久從這裡算；沒有 tool_use_id 的呼叫給一個本地編號
  let seq = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: '開進度面板：這個任務做到哪、Claude 的預估與過去的準度（task-progress）',
      immediate: true,
    })
    await $.tool.register({
      name: 'estimate',
      description:
        '宣告這個任務預計的規模，使用者輸入框上方的進度條照這個算百分比。要動用工具的任務在其他工具呼叫之前先呼叫一次；' +
        '範圍明顯變了再呼叫一次給新的總數（從任務開始算起）。只是回答問題、或一兩次工具就做完的不用呼叫。',
      inputSchema: {
        type: 'object',
        properties: {
          toolCalls: {
            type: 'integer',
            minimum: 1,
            description: '整個任務預計的工具呼叫總次數：只算主對話自己的，派一個子 agent 算一次，不含 estimate 本身',
          },
          costUsd: { type: 'number', exclusiveMinimum: 0, description: '整個任務預計的總花費，美元，含子 agent，照 API 價格估' },
          summary: { type: 'string', description: '一句話說這個任務要做什麼，用使用者的語言，顯示在面板上' },
          reason: { type: 'string', description: '修正預估時寫為什麼改；第一次宣告不用' },
        },
        required: ['toolCalls', 'costUsd', 'summary'],
      },
    })
    const history = await storedHistory($)
    await update($, historyAtom, () => history)
    $.clock.every(1_000, () => tick($))
    return next(e)
  })

  // 每個任務一開始就要呼叫，不能等它從 ToolSearch 載入、也不該每次都問權限：它只是記下幾個數字
  on('tool.describe', { tool: TOOL }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.check', { tool: TOOL }, () => ({ decision: 'allow' as const }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL) || composed.sections.some((s) => s.id === 'task-progress:estimate')) return composed
    return { sections: [...composed.sections, { id: 'task-progress:estimate', text: INSTRUCTIONS, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    if (e.text.trim() === '') await resumeTask($, e.turnId)
    else await startTask($, e.turnId, e.text)
    return next(e)
  })

  // 子 agent 每跑一輪也有 turn.complete，只看主對話的
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await finish($, e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error')
    return result
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { result: '子 agent 不用宣告預估，進度只算主對話。' }
    const input = e as unknown as Record<string, unknown>
    const declared: Declared = { toolCalls: Math.round(Number(input.toolCalls)), costUsd: Number(input.costUsd) }
    if (!(declared.toolCalls >= 1) || !(declared.costUsd > 0)) {
      return { result: 'toolCalls 要是正整數、costUsd 要是正數，請再呼叫一次。' }
    }
    const summary = typeof input.summary === 'string' ? clip(oneLine(input.summary), 60) : ''
    // 熱重載時錯過了這一輪的開始，就從現在算起
    if ((await read($, taskAtom))?.status !== 'running') await startTask($, `task-${await $.clock.now()}`, '')
    const calibration = calibrationOf(await read($, historyAtom))
    const factor = calibration.samples >= MIN_SAMPLES ? calibration.factor : null
    const after = await update($, taskAtom, (t) => {
      if (t === null) return t
      const estimate: Estimate =
        t.estimate === null
          ? { first: declared, latest: declared, revisions: 0, summary, factor, target: factor === null ? declared : scaled(declared, factor) }
          : // Claude 改預估的時候已經看過實際做了多少，直接用它的數字，不再乘倍率
            { ...t.estimate, latest: declared, revisions: t.estimate.revisions + 1, summary: summary || t.estimate.summary, factor: null, target: declared }
      return { ...t, estimate }
    })
    const revised = (after?.estimate?.revisions ?? 0) > 0
    return { result: `已${revised ? '更新' : '記下'}預估：工具 ${declared.toolCalls} 次、${usd(declared.costUsd)}。進度條在使用者的輸入框上方。` }
  })

  // 數工具：主對話的算進進度，子 agent 的另外數
  on('tool.call', async ($, e, next) => {
    if (String(e.tool) === TOOL) return next(e)
    const at = await read($, taskAtom)
    if (at === null || at.status !== 'running') return next(e)
    const taskId = at.id
    if (e.agentId !== undefined) {
      const ran = await next(e)
      await update($, taskAtom, (t) => (t?.id === taskId ? { ...t, agentToolCalls: t.agentToolCalls + 1 } : t))
      return ran
    }
    const id = e.tool_use_id ?? `local-${++seq}`
    const label = labelOf(e as unknown as Record<string, unknown>)
    const begin = await $.clock.now()
    await update($, taskAtom, (t) => (t?.id === taskId ? { ...t, running: [...t.running, { id, label }] } : t))
    let isError = true
    try {
      const ran = await next(e)
      isError = ran.deny !== undefined || ran.isError === true
      return ran
    } finally {
      const done: RecentTool = { label, ms: (await $.clock.now()) - begin, isError }
      await update($, taskAtom, (t) =>
        t?.id !== taskId
          ? t
          : {
              ...t,
              running: t.running.filter((r) => r.id !== id),
              toolCalls: t.toolCalls + 1,
              recent: [done, ...t.recent].slice(0, 8),
            },
      )
    }
  })

  // /progress 開面板；放不下面板的地方把目前的狀態印在對話裡
  on('command.run', { command: 'progress' }, async ($) => {
    if (await openPane($)) return {}
    return { text: format(await read($, taskAtom), await read($, historyAtom), await $.clock.now()) }
  })

  // 輸入框上方的一行：長條加上一顆按鈕，按了開面板。別的插件（cost-ledger）也畫在這一格，
  // 所以把下面畫的接在自己下面，誰先誰後都兩行都在
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const t = await read($, taskAtom)
    if (e.props.hasSurvey || !isShown(t)) return below
    const now = Math.max(await read($, nowAtom), t.startedAt)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // 終端機的元素表也查得到 Svg（畫成空片段），照 surface 判斷
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const cellBar = (cells: Cells, tone: Tone) =>
      cellSegments(cells, tone).map((seg) => (seg.color === null ? <Text dimColor>{seg.text}</Text> : <Text color={seg.color}>{seg.text}</Text>))
    const tone = toneOf(t)
    const fill = fillOf(t)
    const label = `${cardLine(t, now)}  詳細 ›`
    // 終端機的長條塞在按鈕左邊，寬度不夠就只留文字，不折成第二行
    const room = Math.min(CARD_BAR_CELLS, e.props.bodyColumns - columnsOf(label) - 1)
    const cells = progressCells(fill, now, Math.max(0, room))
    const bar =
      Svg !== null ? (
        <Svg source={progressSvg(fill, tone, now, CARD_BAR_WIDTH, CARD_BAR_HEIGHT)} alt={headline(t, now)} />
      ) : room < 6 ? null : (
        <Box flexDirection="row">{cellBar(cells, tone)}</Box>
      )
    return (
      <Box flexDirection="column">
        <Box key="progress-card" flexDirection="row" alignItems="center" gap={1}>
          {bar}
          <Button
            key="open-progress"
            plain
            label={label}
            onPress={async () => {
              if (!(await openPane($))) $.ui.toast('task-progress：這裡放不下面板，打 /progress 把狀態印在對話裡')
            }}
          />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const t = await read($, taskAtom)
    const history = await read($, historyAtom)
    const width = Math.max(20, e.props.bodyColumns)

    const line = (left: string, right: string, dim = false) => (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text dimColor={dim} wrap="truncate-end">
          {left}
        </Text>
        <Text dimColor={dim}>{right}</Text>
      </Box>
    )

    const calibration = calibrationOf(history)
    const accuracy = (
      <Box flexDirection="column">
        <Text bold>預估準度</Text>
        <Text dimColor>
          {calibration.samples >= MIN_SAMPLES
            ? `最近 ${calibration.samples} 筆做完的任務，實際 ÷ 預估的中位數：工具 ${times(calibration.factor.toolCalls)} · 花費 ${times(calibration.factor.costUsd)}。下一個任務的預估會乘上這個倍率。`
            : `做完的有預估任務 ${calibration.samples} 筆，滿 ${MIN_SAMPLES} 筆才開始校正。`}
        </Text>
        {history.slice(0, 8).map((h) =>
          line(
            `${h.status === 'done' ? '' : h.status === 'aborted' ? '■ ' : '✕ '}${h.title || '（沒有說明）'}`,
            [
              `工具 ${h.estimate.toolCalls}→${h.actual.toolCalls}`,
              h.actual.costUsd === null ? null : `${usd(h.estimate.costUsd)}→${usd(h.actual.costUsd)}`,
              clock(h.actual.durationMs),
            ]
              .filter((x): x is string => x !== null)
              .join(' · '),
            true,
          ),
        )}
      </Box>
    )

    if (t === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>還沒有任務。交代一件要動用工具的事，Claude 會先給預估，這裡就開始算進度。</Text>
          {accuracy}
        </Box>
      )
    }

    const now = Math.max(await read($, nowAtom), t.startedAt)
    const cellBar = (cells: Cells, tone: Tone) =>
      cellSegments(cells, tone).map((seg) => (seg.color === null ? <Text dimColor>{seg.text}</Text> : <Text color={seg.color}>{seg.text}</Text>))
    const tone = toneOf(t)
    const fill = fillOf(t)
    const remaining = remainingOf(t, now)
    const cells = progressCells(fill, now, Math.min(width, 36))
    const est = t.estimate

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">
            {est?.summary || t.prompt || '這個任務'}
          </Text>
          {est?.summary && t.prompt ? (
            <Text dimColor wrap="truncate-end">
              {t.prompt}
            </Text>
          ) : null}
        </Box>
        <Box flexDirection="column">
          <Text bold color={COLORS[tone]}>
            {headline(t, now)}
          </Text>
          {Svg === null ? (
            <Box flexDirection="row">{cellBar(cells, tone)}</Box>
          ) : (
            <Svg source={progressSvg(fill, tone, now, Math.max(200, width * 10), 10)} alt={headline(t, now)} />
          )}
          {line('經過', remaining === null ? clock(elapsedOf(t, now)) : `${clock(elapsedOf(t, now))} · 約剩 ${clock(remaining)}`)}
        </Box>
        <Box flexDirection="column">
          {line('工具呼叫', est === null ? `${t.toolCalls}` : `${t.toolCalls} / ${est.target.toolCalls}`)}
          {t.costUsd === null ? null : line('花費', est === null ? usd(t.costUsd) : `${usd(t.costUsd)} / ${usd(est.target.costUsd)}`)}
          {est === null ? (
            <Text dimColor>{t.status === 'running' ? 'Claude 還沒給預估，先只顯示做了多少。' : '這個任務沒有預估。'}</Text>
          ) : (
            <Text dimColor>
              {[
                `Claude 預估工具 ${est.latest.toolCalls} 次、${usd(est.latest.costUsd)}`,
                est.revisions > 0 ? `改過 ${est.revisions} 次，照最新的算` : null,
                est.factor === null ? null : `依過去紀錄校正：工具 ${times(est.factor.toolCalls)}、花費 ${times(est.factor.costUsd)}`,
              ]
                .filter((x): x is string => x !== null)
                .join('；')}
            </Text>
          )}
          {t.agentToolCalls > 0 ? <Text dimColor>{`子 agent 呼叫了 ${t.agentToolCalls} 次工具（不算進工具次數，花費有算）`}</Text> : null}
        </Box>
        {t.running.length === 0 ? null : (
          <Box flexDirection="column">
            <Text bold>正在跑</Text>
            {t.running.map((r) => (
              <Text wrap="truncate-end">{`${SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? '◐'} ${r.label}`}</Text>
            ))}
          </Box>
        )}
        {t.recent.length === 0 ? null : (
          <Box flexDirection="column">
            <Text bold>剛跑完</Text>
            {t.recent.map((r) => line(`${r.isError ? '✕' : '✓'} ${r.label}`, `${(r.ms / 1000).toFixed(1)}s`, true))}
          </Box>
        )}
        {accuracy}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    // /clear 之後是新的對話，卡片不留上一段的任務
    if (e.reason === 'clear') await update($, taskAtom, () => null)
    return next(e)
  })
}
