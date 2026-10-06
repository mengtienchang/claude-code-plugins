import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepInput, TurnStepResult } from 'claude-code'

import type { Amount, LedgerView, ModelAmount, PrLedger, RecentRequest, Summary } from '../types'

// ---- 定價 ----
// 每百萬 token 的美元單價。PRICE_TABLE 是官方定價表的日期，記在每一筆紀錄上，價格改了還能照當時的表重算
const PRICE_TABLE = '2026-09-25'

type Price = { input: number; output: number; write5m: number; write1h: number; read: number }

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 0.25 },
  'claude-fable-5': { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
  'claude-opus-5-5': { input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 },
}

// 長的名字先比，claude-opus-5-5 才不會被 claude-opus-5 吃掉；帶日期的版本（claude-haiku-4-5-20251001）照前綴對
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length)

const priceOf = (model: string): Price | null => {
  const key = PRICE_KEYS.find((k) => model === k || model.startsWith(`${k}-`))
  return key === undefined ? null : (PRICES[key] ?? null)
}

type CacheTtl = '5m' | '1h'

// mod 拿到的用量只有四種 token，快取寫入沒分時效，只能推定：主對話照訂閱方案的 1 小時，子 agent 用 5 分鐘
// （2026-09 的對話紀錄裡兩邊各自一律如此）。每一筆都標 ttlSource，session 報表會對 Claude Code 自己的帳
const ttlOf = (agentId: string | null): CacheTtl => (agentId === null ? '1h' : '5m')

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
type Cost = { input: number; output: number; cacheWrite: number; cacheRead: number; total: number }
// 送出到第一個片段（排隊、讀 prompt），與第一個片段到串流結束（生成）各花多久，毫秒
type Timing = { ttftMs: number; genMs: number }

const costOf = (tokens: Tokens, price: Price, ttl: CacheTtl): Cost => {
  const usd = (count: number, perMillion: number) => (count * perMillion) / 1e6
  const parts = {
    input: usd(tokens.input, price.input),
    output: usd(tokens.output, price.output),
    cacheWrite: usd(tokens.cacheWrite, ttl === '1h' ? price.write1h : price.write5m),
    cacheRead: usd(tokens.cacheRead, price.read),
  }
  return { ...parts, total: parts.input + parts.output + parts.cacheWrite + parts.cacheRead }
}

// ---- 帳本的列 ----
// 一次模型請求一列；PR 證據與子 agent 的任務另外各一列，歸屬留到查詢時再算，原始事實不先套推論
type RequestRow = {
  v: 1
  kind: 'request'
  ts: string
  session: string
  agentId: string | null
  turnId: string
  step: number
  model: string
  requestedModel: string
  effort: string | number | null
  messageCount: number
  stopReason: string | null
  tokens: Tokens
  contextTokens: number
  // 加上計時之前記的列沒有這一欄；串流一個片段都沒有的是 null
  timing?: Timing | null
  cacheTtl: CacheTtl
  ttlSource: 'assumed'
  priceTable: string
  prices: Price | null
  costUsd: Cost | null
  branch: string | null
  engineCostUsd: number | null
}

type EvidenceRow = {
  v: 1
  kind: 'evidence'
  ts: string
  session: string
  agentId: string | null
  pr: number | null
  branch: string | null
  how: 'pr-create' | 'pr-command' | 'push' | 'branch-create'
}

type AgentRow = {
  v: 1
  kind: 'agent'
  ts: string
  session: string
  agentId: string
  parentAgentId: string | null
  description: string
  subagentType: string
  model: string
  cwd: string | null
}

type Row = RequestRow | EvidenceRow | AgentRow
type Evidence = Pick<EvidenceRow, 'pr' | 'branch' | 'how'>

// ---- 從指令找「這段在做哪支 PR、哪個分支」 ----
const PR_URL = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g
// gh pr view 常拿來讀別支 PR 當參考，不算證據
const PR_CMD = /\bgh pr (?:checkout|diff|review|comment|edit|ready|merge)\s+#?(\d+)\b/g
const BRANCH_CREATE = /\bgit\s+(?:switch|checkout)\s+(?:-c|-C|-b|-B|--create|--force-create)\s+([^\s'";|&]+)/

const evidenceFrom = (command: string, output: string): Evidence[] => {
  const found: Evidence[] = []
  if (/\bgh pr create\b/.test(command)) {
    for (const m of output.matchAll(PR_URL)) found.push({ pr: Number(m[1]), branch: null, how: 'pr-create' })
  }
  for (const m of command.matchAll(PR_CMD)) found.push({ pr: Number(m[1]), branch: null, how: 'pr-command' })
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const created = segment.match(BRANCH_CREATE)
    if (created?.[1]) found.push({ pr: null, branch: created[1], how: 'branch-create' })
    const push = segment.match(/\bgit\s+push\b(.*)/)
    if (!push) continue
    // git push [remote] [refspec…]：旗標之後第一個是 remote，其餘是 refspec，取冒號後的目的分支
    const args = (push[1] ?? '').trim().split(/\s+/).filter((t) => t !== '' && !t.startsWith('-'))
    for (const ref of args.slice(1)) {
      const dst = (ref.split(':').pop() ?? '').replace(/^\+/, '').replace(/^refs\/heads\//, '')
      if (dst !== '' && dst !== 'HEAD') found.push({ pr: null, branch: dst, how: 'push' })
    }
  }
  return found
}

const outputOf = (ran: unknown): string => {
  const r = ran as { result?: { stdout?: unknown }; text?: unknown }
  return [r.result?.stdout, r.text].filter((x): x is string => typeof x === 'string').join('\n')
}

// ---- 面板的狀態 ----
// 畫面讀的值放 $.state：熱重載時模組變數會清空，這些留著
const PANE = 'cost-ledger'
const PANE_TITLE = '花費'

const emptySummary = (title: string): Summary => ({
  title,
  sessions: 0,
  requests: 0,
  totalUsd: 0,
  parts: [],
  bySource: [],
  byModel: [],
  byTarget: [],
  unpriced: 0,
  notes: [],
  recent: [],
  speed: { latest: null, average: null },
  firstToken: { latest: null, average: null },
})

const sessionLedger = atom({ plugin: 'cost-ledger', key: 'session' } as const, emptySummary('這個 session'))
const prLedger = atom({ plugin: 'cost-ledger', key: 'pr' } as const, null as PrLedger | null)
const ledgerView = atom({ plugin: 'cost-ledger', key: 'view' } as const, 'session' as LedgerView)
const prLoading = atom({ plugin: 'cost-ledger', key: 'isLoading' } as const, false)

// ---- 寫帳 ----
// $.fs 一次讀寫上限 4 MiB，而且沒有 append，只能整份重寫：一個 session 一天一個檔，長到這裡就換下一個
const ROLL_AT = 3_500_000

let sessionId = ''
let root = ''
let pending: Row[] = []
// 這個 session 的每一列（含還沒寫進檔的），面板的即時帳從這裡算；載入時從檔案重建
let sessionRows: Row[] = []
const fileText = new Map<string, string>()
let flushing: Promise<void> = Promise.resolve()
// 目錄 → 當下的分支，30 秒內不重查；同一個目錄裡有人切分支就作廢
const branchCache = new Map<string, { value: string | null; at: number }>()
// 派出時指定了目錄的子 agent（自己的 worktree），之後的請求到那個目錄查分支
const agentCwd = new Map<string, string>()

async function ensureInit($: EngineInterface): Promise<boolean> {
  if (sessionId === '') sessionId = await $.session.id()
  if (root === '') {
    const home = await $.env.get('HOME')
    if (home) root = `${home}/.claude/cost-ledger`
  }
  return sessionId !== '' && root !== ''
}

async function flushNow($: EngineInterface): Promise<void> {
  if (pending.length === 0 || !(await ensureInit($))) return
  const rows = pending
  pending = []
  const byDay = new Map<string, Row[]>()
  for (const r of rows) {
    const day = r.ts.slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), r])
  }
  for (const [day, list] of byDay) {
    try {
      const lines = list.map((r) => `${JSON.stringify(r)}\n`).join('')
      for (let seq = 1; ; seq++) {
        const path = `${root}/${day}/${sessionId}${seq > 1 ? `-${seq}` : ''}.jsonl`
        let text = fileText.get(path)
        if (text === undefined) {
          text = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
          fileText.set(path, text)
        }
        if (text.length >= ROLL_AT) continue
        await $.fs.write(path, text + lines)
        fileText.set(path, text + lines)
        break
      }
    } catch (err) {
      // 寫不進去就放回去等下一次，原因進 debug log
      pending = list.concat(pending)
      $.ui.log(`cost-ledger: 寫帳失敗：${String(err)}`, { to: 'debug' })
    }
  }
}

// 計時器、緩衝滿了、session 結束、查帳都會叫；排成一條，免得兩次同時讀到舊內容互相蓋掉
function flush($: EngineInterface): Promise<void> {
  flushing = flushing.then(() => flushNow($)).catch(() => undefined)
  return flushing
}

// 每一列都從這裡進帳：排進待寫，屬於這個 session 的也進即時帳，面板跟著重算
async function append($: EngineInterface, row: Row): Promise<void> {
  pending.push(row)
  if (row.session === sessionId) {
    sessionRows.push(row)
    await refreshSession($)
  }
  if (pending.length >= 200) void flush($)
}

async function branchIn($: EngineInterface, cwd: string): Promise<string | null> {
  const now = await $.clock.now()
  const cached = branchCache.get(cwd)
  if (cached && now - cached.at < 30_000) return cached.value
  const r = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 3_000 })
  const name = r.stdout.trim()
  const value = r.exitCode === 0 && name !== '' ? name : null
  branchCache.set(cwd, { value, at: now })
  return value
}

// 主對話查 session 的目錄；子 agent 只在派出時指定了目錄才查，沒指定的可能 cd 去別的 worktree，留空交給證據列
async function branchOf($: EngineInterface, agentId: string | null): Promise<string | null> {
  if (agentId === null) return branchIn($, await $.session.cwd())
  const cwd = agentCwd.get(agentId)
  return cwd === undefined ? null : branchIn($, cwd)
}

async function recordRequest(
  $: EngineInterface,
  e: TurnStepInput,
  result: TurnStepResult,
  timing: Timing | null,
): Promise<void> {
  const u = result.usage
  if (u === null || !(await ensureInit($))) return
  const agentId = e.agentId ?? null
  const tokens: Tokens = {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  }
  const ttl = ttlOf(agentId)
  const prices = priceOf(u.model)
  const usage = await $.session.usage()
  await append($, {
    v: 1,
    kind: 'request',
    ts: new Date(await $.clock.now()).toISOString(),
    session: sessionId,
    agentId,
    turnId: e.turnId,
    step: e.index,
    model: u.model,
    requestedModel: e.model,
    effort: e.effort ?? null,
    messageCount: e.messageCount,
    stopReason: result.stopReason,
    tokens,
    contextTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
    timing,
    cacheTtl: ttl,
    ttlSource: 'assumed',
    priceTable: PRICE_TABLE,
    prices,
    costUsd: prices === null ? null : costOf(tokens, prices, ttl),
    branch: await branchOf($, agentId),
    engineCostUsd: usage.cost?.usd ?? null,
  })
}

// ---- 查帳 ----
type Target = { pr: number | null; branch: string | null }

// 同一個 session、同一個 agent 的列依時間排：每次請求歸給它之後的第一個證據（做到開 PR 為止的工作算那支），
// 最後一個證據之後的收尾歸最後那個；完全沒證據的主對話退回當時的分支
const attribute = (rows: Row[]): Map<RequestRow, Target> => {
  const streams = new Map<string, Array<RequestRow | EvidenceRow>>()
  for (const r of rows) {
    if (r.kind === 'agent') continue
    const key = `${r.session}|${r.agentId ?? ''}`
    streams.set(key, [...(streams.get(key) ?? []), r])
  }
  const targets = new Map<RequestRow, Target>()
  for (const list of streams.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts))
    const evidence = list.filter((r): r is EvidenceRow => r.kind === 'evidence')
    for (const r of list) {
      if (r.kind !== 'request') continue
      const next = evidence.find((x) => x.ts >= r.ts) ?? evidence[evidence.length - 1]
      targets.set(r, next ? { pr: next.pr, branch: next.branch } : { pr: null, branch: r.branch })
    }
  }
  return targets
}

const agentNamesOf = (rows: Row[]): Map<string, string> => {
  const names = new Map<string, string>()
  for (const r of rows) if (r.kind === 'agent') names.set(r.agentId, r.description)
  return names
}

async function readRows($: EngineInterface, onlySession: string | null): Promise<Row[]> {
  if (!(await $.fs.exists(root))) return []
  const rows: Row[] = []
  for (const day of await $.fs.list(root)) {
    if (day.kind !== 'dir') continue
    for (const file of await $.fs.list(`${root}/${day.name}`)) {
      if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
      if (onlySession !== null && !file.name.startsWith(onlySession)) continue
      const text = String(await $.fs.read(`${root}/${day.name}/${file.name}`))
      for (const line of text.split('\n')) {
        if (line === '') continue
        try {
          rows.push(JSON.parse(line) as Row)
        } catch {
          // 寫到一半的行跳過
        }
      }
    }
  }
  return rows
}

async function headBranchOf($: EngineInterface, pr: number): Promise<string | null> {
  const r = await $.process.run(['gh', 'pr', 'view', String(pr), '--json', 'headRefName', '-q', '.headRefName'], {
    cwd: await $.session.cwd(),
    timeoutMs: 15_000,
  })
  const name = r.stdout.trim()
  return r.exitCode === 0 && name !== '' ? name : null
}

const usd = (x: number) => `$${x.toFixed(2)}`
const pct = (x: number, total: number) => (total > 0 ? `${((x / total) * 100).toFixed(1)}%` : '—')
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v)
const ranked = (m: Map<string, number>): Amount[] =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, v]) => ({ label, usd: v }))
const shortModel = (model: string) => model.replace(/^claude-/, '')
const tps = (x: number) => `${Math.round(x)} tok/s`
const perSecond = (output: number, genMs: number) => (genMs > 0 ? (output * 1000) / genMs : null)
// 加上計時之前記的列、一個片段都沒有的請求沒有生成時間，算不出速度
const genMsOf = (r: RequestRow) => r.timing?.genMs ?? 0
// 同樣的列也沒有首字時間；不能當成 0，否則平均會被拉低
const ttftOf = (r: RequestRow) => r.timing?.ttftMs ?? null
const mean = (m: { totalMs: number; count: number } | undefined) => (m === undefined || m.count === 0 ? null : m.totalMs / m.count)
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const sourceOf = (r: RequestRow, agentNames: Map<string, string>) =>
  r.agentId === null ? '主對話' : (agentNames.get(r.agentId) ?? `子 agent ${r.agentId.slice(0, 8)}`)

// 依 token 種類的五項。順序與顏色跟著項目走，哪一項是零、其餘的都不換色。
// 三個主色在淺色、深色底上任兩色並排都分得開（含色盲模擬）；兩種快取寫入同一個橘，5 分鐘的加斜紋；
// 未快取的輸入通常趨近零，用中性灰。桌面版的 Svg 畫成圖片、跟不到主題，所以選兩種底都過的同一組
type PartKey = 'read' | 'write1h' | 'write5m' | 'output' | 'input'
type PartStyle = { key: PartKey; label: string; fill: string; isHatched: boolean }

const NEUTRAL = '#898781'

const PARTS: readonly PartStyle[] = [
  { key: 'read', label: '快取讀取', fill: '#3987e5', isHatched: false },
  { key: 'write1h', label: '快取寫入（1 小時）', fill: '#d95926', isHatched: false },
  { key: 'write5m', label: '快取寫入（5 分鐘）', fill: '#d95926', isHatched: true },
  { key: 'output', label: '輸出', fill: '#199e70', isHatched: false },
  { key: 'input', label: '未快取的輸入', fill: NEUTRAL, isHatched: false },
]

// 面板與 markdown 共用同一份數字
const summarize = (
  title: string,
  requests: RequestRow[],
  targets: Map<RequestRow, Target>,
  agentNames: Map<string, string>,
  notes: string[],
): Summary => {
  const parts: Record<PartKey, number> = { read: 0, write1h: 0, write5m: 0, output: 0, input: 0 }
  const byModel = new Map<string, number>()
  const bySource = new Map<string, number>()
  const byTarget = new Map<string, number>()
  const sessions = new Set<string>()
  // 速度照總輸出除以總生成時間，長的回應權重大；只叫一個工具的短回應單筆跳很大，平均不被它帶著走
  const speedByModel = new Map<string, { output: number; genMs: number }>()
  const speed = { output: 0, genMs: 0 }
  // 首字時間每次請求各一個，直接平均：它跟輸出多長無關，主要看 prompt 多大、有沒有快取到
  const ttftByModel = new Map<string, { totalMs: number; count: number }>()
  const ttft = { totalMs: 0, count: 0 }
  let total = 0
  let unpriced = 0
  for (const r of requests) {
    sessions.add(r.session)
    const genMs = genMsOf(r)
    if (genMs > 0) {
      speed.output += r.tokens.output
      speed.genMs += genMs
      const m = speedByModel.get(r.model) ?? { output: 0, genMs: 0 }
      speedByModel.set(r.model, { output: m.output + r.tokens.output, genMs: m.genMs + genMs })
    }
    const ttftMs = ttftOf(r)
    if (ttftMs !== null) {
      ttft.totalMs += ttftMs
      ttft.count++
      const m = ttftByModel.get(r.model) ?? { totalMs: 0, count: 0 }
      ttftByModel.set(r.model, { totalMs: m.totalMs + ttftMs, count: m.count + 1 })
    }
    const c = r.costUsd
    if (c === null) {
      unpriced++
      continue
    }
    total += c.total
    parts.read += c.cacheRead
    parts.output += c.output
    parts.input += c.input
    if (r.cacheTtl === '1h') parts.write1h += c.cacheWrite
    else parts.write5m += c.cacheWrite
    add(byModel, r.model, c.total)
    add(bySource, sourceOf(r, agentNames), c.total)
    const t = targets.get(r)
    add(byTarget, t?.pr != null ? `PR #${t.pr}` : t?.branch ? `分支 ${t.branch}` : '未歸屬', c.total)
  }
  const newestFirst = [...requests].sort((a, b) => b.ts.localeCompare(a.ts))
  const recent: RecentRequest[] = newestFirst.slice(0, 8).map((r) => ({
    source: sourceOf(r, agentNames),
    model: shortModel(r.model),
    usd: r.costUsd?.total ?? null,
    contextTokens: r.contextTokens,
    tokensPerSecond: perSecond(r.tokens.output, genMsOf(r)),
  }))
  const latest = newestFirst.find((r) => genMsOf(r) > 0)
  const latestTtft = newestFirst.map(ttftOf).find((ms) => ms !== null) ?? null
  const models: ModelAmount[] = ranked(byModel).map((a) => {
    const m = speedByModel.get(a.label)
    return { ...a, tokensPerSecond: m === undefined ? null : perSecond(m.output, m.genMs), ttftMs: mean(ttftByModel.get(a.label)) }
  })
  return {
    title,
    sessions: sessions.size,
    requests: requests.length,
    totalUsd: total,
    parts: PARTS.map((p) => ({ label: p.label, usd: parts[p.key] })),
    bySource: ranked(bySource),
    byModel: models,
    byTarget: ranked(byTarget),
    unpriced,
    notes,
    recent,
    speed: {
      latest: latest === undefined ? null : perSecond(latest.tokens.output, genMsOf(latest)),
      average: perSecond(speed.output, speed.genMs),
    },
    firstToken: { latest: latestTtft, average: mean(ttft) },
  }
}

const ASSUMPTION = '快取寫入的時效是推定的（主對話 1 小時、子 agent 5 分鐘）；思考 token 與網路搜尋次數 mod 拿不到，不在帳上。'
const SPEED_NOTE = '輸出速度是輸出 token 除以生成時間（第一個片段到串流結束），等第一個片段的時間不算。'
const TTFT_NOTE = '首字時間是送出請求到收到第一個回應片段的時間，含排隊與讀 prompt；第一個片段是思考的也算，所以不含思考的時間。平均是每次請求直接平均。'
const inline = (list: Amount[]) => list.map((a) => `${a.label} ${usd(a.usd)}`).join('、')
// 一個模型的平均輸出速度與平均首字時間，沒計時的那項不列
const timingOf = (a: ModelAmount): string[] => [
  ...(a.tokensPerSecond === null ? [] : [tps(a.tokensPerSecond)]),
  ...(a.ttftMs === null ? [] : [`首字 ${secs(a.ttftMs)}`]),
]
const withSpeed = (list: ModelAmount[]) =>
  list
    .map((a) => {
      const timing = timingOf(a)
      return `${a.label} ${usd(a.usd)}${timing.length === 0 ? '' : `（${timing.join('、')}）`}`
    })
    .join('、')

const format = (s: Summary): string => {
  if (s.requests === 0) return `cost-ledger｜${s.title}：還沒有紀錄。`
  return [
    `**cost-ledger｜${s.title}**`,
    `${s.sessions} 個 session、${s.requests} 次請求，共 **${usd(s.totalUsd)}**（照定價表 ${PRICE_TABLE} 的 API 價格換算）`,
    '',
    '| 項目 | 金額 | 佔比 |',
    '| --- | ---: | ---: |',
    ...s.parts.map((p) => `| ${p.label} | ${usd(p.usd)} | ${pct(p.usd, s.totalUsd)} |`),
    '',
    `依來源：${inline(s.bySource)}`,
    `依模型：${withSpeed(s.byModel)}`,
    `依歸屬：${inline(s.byTarget)}`,
    ...(s.speed.average === null ? [] : [`輸出速度平均 ${tps(s.speed.average)}。${SPEED_NOTE}`]),
    ...(s.firstToken.average === null ? [] : [`首字時間平均 ${secs(s.firstToken.average)}。${TTFT_NOTE}`]),
    ...(s.unpriced > 0 ? [`有 ${s.unpriced} 次請求的模型不在定價表裡，沒算進金額。`] : []),
    ASSUMPTION,
    ...s.notes,
  ].join('\n')
}

// ---- 桌面版的圖 ----
// Svg 在桌面版畫成圖片、跟不到主題：圖裡只放色塊，字一律交給 Text
const styleOf = (label: string) => PARTS.find((p) => p.label === label)
// 斜紋是同色系深一階的線，45 度
const HATCH_INK = '#9c3a15'

const hatch = (fill: string, size: number) =>
  `<pattern id="hatch" width="${size}" height="${size}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
  `<rect width="${size}" height="${size}" fill="${fill}"/><rect width="${size * 0.4}" height="${size}" fill="${HATCH_INK}"/></pattern>`

const svg = (width: number, height: number, defs: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<defs>${defs}</defs>${body}</svg>`

const fillOf = (style: PartStyle | undefined) =>
  style === undefined ? NEUTRAL : style.isHatched ? 'url(#hatch)' : style.fill

// 一條 100% 的堆疊長條，上下各留一點空白當行距。兩端 4 單位圓角，段與段之間留空隙透出底色，不畫框線；
// 窄到不滿 1 單位的段不畫（圖例照列），其餘的照比例分掉
const BAR_HEIGHT = 14
const BAR_PAD = 5
const BAR_GAP = 2.5

// 卡片只佔一行：長條跟在總額那行的右邊，細到比字矮，上下不留空白
const CARD_BAR_WIDTH = 120
const CARD_BAR_HEIGHT = 6
const CARD_BAR_CELLS = 20

const stackedBar = (parts: Amount[], width: number, height = BAR_HEIGHT, pad = BAR_PAD): string => {
  const total = parts.reduce((sum, p) => sum + p.usd, 0)
  const shown = parts.filter((p) => total > 0 && (p.usd / total) * width >= 1)
  const drawn = shown.reduce((sum, p) => sum + p.usd, 0)
  const room = width - BAR_GAP * Math.max(0, shown.length - 1)
  let x = 0
  const rects = shown.map((p) => {
    const w = (p.usd / drawn) * room
    const rect = `<rect x="${x.toFixed(2)}" y="${pad}" width="${w.toFixed(2)}" height="${height}" fill="${fillOf(styleOf(p.label))}"/>`
    x += w + BAR_GAP
    return rect
  })
  const hatched = shown.map((p) => styleOf(p.label)).find((s) => s?.isHatched)
  const defs =
    `<clipPath id="ends"><rect y="${pad}" width="${width}" height="${height}" rx="${Math.min(4, height / 2)}"/></clipPath>` +
    (hatched ? hatch(hatched.fill, 8) : '')
  return svg(width, height + pad * 2, defs, `<g clip-path="url(#ends)">${rects.join('')}</g>`)
}

// 終端機的顯示寬度：中日韓字與全形標點佔兩格，其餘一格
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/
const columnsOf = (text: string) => [...text].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

// 終端機沒有 Svg，卡片的長條用字元畫：一項一段、照比例分格，四捨五入差的格數給小數部分最大的幾項，總長剛好 width；
// 分不到一格的項不畫，5 分鐘的快取寫入用 ▒ 跟 1 小時的分開
const cellsOf = (parts: Amount[], width: number): Array<{ label: string; cells: number }> => {
  const total = parts.reduce((sum, p) => sum + p.usd, 0)
  if (total <= 0) return []
  const split = parts.map((p) => {
    const exact = (p.usd / total) * width
    return { label: p.label, cells: Math.floor(exact), rest: exact - Math.floor(exact) }
  })
  let left = width - split.reduce((sum, s) => sum + s.cells, 0)
  for (const s of [...split].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break
    s.cells++
    left--
  }
  return split.filter((s) => s.cells > 0).map(({ label, cells }) => ({ label, cells }))
}

const swatch = (label: string): string => {
  const style = styleOf(label)
  return svg(10, 10, style?.isHatched ? hatch(style.fill, 4) : '', `<rect width="10" height="10" rx="2.5" fill="${fillOf(style)}"/>`)
}

const sessionSummary = (): Summary => {
  const mine = sessionRows.filter((r): r is RequestRow => r.kind === 'request')
  const engine = mine.reduce<number | null>((last, r) => r.engineCostUsd ?? last, null)
  const notes =
    engine === null
      ? []
      : [`Claude Code 自己記的這個 session 累計 ${usd(engine)}。本帳從 mod 載入後才開始記，兩邊的差是載入前的部分加上推定誤差。`]
  return summarize('這個 session', mine, attribute(sessionRows), agentNamesOf(sessionRows), notes)
}

async function prSummary($: EngineInterface, pr: number): Promise<Summary> {
  await flush($)
  const rows = await readRows($, null)
  const targets = attribute(rows)
  const branch = await headBranchOf($, pr)
  const picked = [...targets].filter(([, t]) => t.pr === pr || (branch !== null && t.branch === branch)).map(([r]) => r)
  const notes = branch === null ? ['查不到這支 PR 的分支（gh 失敗或不在 repo 裡），只算有 PR 編號證據的部分。'] : []
  return summarize(`PR #${pr}`, picked, targets, agentNamesOf(rows), notes)
}

const prArg = (args: string): number | null => {
  const asked = args.trim().match(/^pr\s+#?(\d+)$/i)
  return asked ? Number(asked[1]) : null
}

async function report($: EngineInterface, args: string): Promise<string> {
  await flush($)
  if (!(await ensureInit($))) return 'cost-ledger：讀不到 HOME，帳本沒有地方寫。'
  const pr = prArg(args)
  return format(pr === null ? sessionSummary() : await prSummary($, pr))
}

async function refreshSession($: EngineInterface): Promise<void> {
  const summary = sessionSummary()
  await update($, sessionLedger, () => summary)
}

// 載入（含熱重載）與 /clear 之後：從檔案把這個 session 已記的帳讀回來
async function reloadSession($: EngineInterface): Promise<void> {
  if (!(await ensureInit($))) return
  const onDisk = await readRows($, sessionId)
  sessionRows = onDisk.concat(pending.filter((r) => r.session === sessionId))
  await refreshSession($)
}

async function loadPr($: EngineInterface, pr: number): Promise<void> {
  await update($, prLoading, () => true)
  try {
    if (!(await ensureInit($))) return
    const summary = await prSummary($, pr)
    await update($, prLedger, () => ({ number: pr, summary }))
  } finally {
    await update($, prLoading, () => false)
  }
}

// 面板只在使用者要看的時候開（/ledger、按卡片），不在 session 開始時自己開
const openPane = async ($: EngineInterface) => (await $.ui.open({ id: PANE, title: PANE_TITLE })).isPlaced

// 卡片的那一行：總額，有計時的話加上最近一次與平均的輸出速度、平均首字時間
const cardLine = (s: Summary): string => {
  const { latest, average } = s.speed
  const speed = latest === null || average === null ? '' : ` · 輸出 ${tps(latest)}（平均 ${Math.round(average)}）`
  const ttft = s.firstToken.average === null ? '' : ` · 首字平均 ${secs(s.firstToken.average)}`
  return `花費 ${usd(s.totalUsd)}${speed}${ttft}  詳細 ›`
}

const TOOL = 'mcp__cost-ledger__ledger'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ledger',
      description: '開花費面板：這個 session 的即時帳，或某支 PR 的帳（cost-ledger）',
      argumentHint: '[pr <編號>]',
      immediate: true,
    })
    await $.tool.register({
      name: 'ledger',
      description:
        '查 cost-ledger 記下的模型花費結構。不給 pr 就是這個 session；給 pr 就是那支 PR，跨所有 session 與子 agent。' +
        '回傳 markdown（照 token 種類拆的金額表，以及依來源、模型、歸屬的金額），可以直接貼進 PR 內文。金額是照 API 定價換算的等值金額，不是帳單。',
      inputSchema: {
        type: 'object',
        properties: { pr: { type: 'integer', description: 'PR 編號；不給就查這個 session' } },
      },
    })
    $.clock.every(15_000, () => {
      void flush($)
    })
    await reloadSession($)
    return next(e)
  })

  // 生成時間從第一個片段算起：引擎的片段（封包、區塊開頭）也算，思考沒顯示出來的時候才不會把那段漏掉、速度虛高。
  // 中途重試的話，重試標記也是片段，那次的生成時間會連重試前的等待一起算進去
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    let firstAt: number | null = null
    const stream = next(e)
    for await (const chunk of stream) {
      if (firstAt === null) firstAt = await $.clock.now()
      yield chunk
    }
    const result = await stream.result
    const timing = firstAt === null ? null : { ttftMs: firstAt - sentAt, genMs: (await $.clock.now()) - firstAt }
    if (result.usage) await recordRequest($, e, result, timing)
    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    // 有人切了分支，下一次請求一律重新查
    if (/\bgit\s+(?:switch|checkout)\b/.test(e.command)) branchCache.clear()
    const found = evidenceFrom(e.command, outputOf(ran))
    if (found.length > 0 && (await ensureInit($))) {
      const ts = new Date(await $.clock.now()).toISOString()
      for (const f of found) await append($, { v: 1, kind: 'evidence', ts, session: sessionId, agentId: e.agentId ?? null, ...f })
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny === undefined && spawned.agentId !== undefined && (await ensureInit($))) {
      if (e.cwd !== undefined) agentCwd.set(spawned.agentId, e.cwd)
      await append($, {
        v: 1,
        kind: 'agent',
        ts: new Date(await $.clock.now()).toISOString(),
        session: sessionId,
        agentId: spawned.agentId,
        parentAgentId: e.parentAgentId ?? null,
        description: e.description,
        subagentType: e.subagentType,
        model: spawned.model,
        cwd: e.cwd ?? null,
      })
    }
    return spawned
  })

  // /ledger 開面板；/ledger pr <編號> 開面板並切到那支 PR，重算時面板先顯示讀取中。放不下面板的地方照舊印 markdown
  on('command.run', { command: 'ledger' }, async ($, e) => {
    const pr = prArg(e.args)
    await update($, ledgerView, () => (pr === null ? 'session' : 'pr'))
    if (await openPane($)) {
      if (pr !== null) await loadPr($, pr)
      return {}
    }
    return { text: await report($, e.args) }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const pr = Number(e.pr)
    return { result: await report($, Number.isInteger(pr) && pr > 0 ? `pr ${pr}` : '') }
  })

  // 輸入框上方常駐的卡片，只佔一行：總額與輸出速度是一顆按鈕，按了開面板看這個 session 的詳細；右邊跟一條細的各項比例長條。
  // 終端機寬度不夠放長條時只留按鈕，不折成兩行。有問卷要用這一格就讓開，還沒有任何請求也不佔位。
  // 別的插件（task-progress）也畫在這一格，把下面畫的接在自己下面，誰先誰後兩行都在
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const s = await read($, sessionLedger)
    if (e.props.hasSurvey || s.requests === 0) return below
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // 終端機沒有 Svg，畫字元長條（元素表的判斷見面板那邊）
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const shown = s.parts.filter((p) => p.usd > 0)
    const label = cardLine(s)
    // 按鈕與長條之間空一格
    const barCells = Math.min(CARD_BAR_CELLS, e.props.bodyColumns - columnsOf(label) - 1)
    const bar =
      Svg === null ? (
        barCells < 6 ? null : (
          <Box flexDirection="row">
            {cellsOf(shown, barCells).map((c) => {
              const style = styleOf(c.label)
              return <Text color={style?.fill ?? NEUTRAL}>{(style?.isHatched ? '▒' : '█').repeat(c.cells)}</Text>
            })}
          </Box>
        )
      ) : (
        <Svg
          source={stackedBar(shown, CARD_BAR_WIDTH, CARD_BAR_HEIGHT, 0)}
          alt={shown.map((p) => `${p.label} ${pct(p.usd, s.totalUsd)}`).join('、')}
        />
      )
    return (
      <Box flexDirection="column">
        <Box key="card" flexDirection="row" alignItems="center" gap={1}>
          <Button
            key="open-pane"
            plain
            label={label}
            onPress={async () => {
              await update($, ledgerView, () => 'session')
              if (!(await openPane($))) $.ui.toast('cost-ledger：這裡放不下面板，打 /ledger 把表印在對話裡')
            }}
          />
          {shown.length === 0 ? null : bar}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // 終端機沒有 Svg，照舊畫字元長條。元素表會補齊每個元素名、介面沒有的畫成空片段，
    // 終端機的表裡也查得到 Svg，所以照 surface 判斷
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    const view = await read($, ledgerView)
    const pr = await read($, prLedger)
    const isLoading = await read($, prLoading)
    const showsPr = view === 'pr'
    const s = showsPr ? (pr?.summary ?? null) : await read($, sessionLedger)
    const width = Math.max(20, e.props.bodyColumns)
    const barWidth = Math.min(width, 36)

    const line = (left: string, right: string, dim = false) => (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text dimColor={dim} wrap="truncate-end">
          {left}
        </Text>
        <Text dimColor={dim}>{right}</Text>
      </Box>
    )
    const bar = (share: number) => {
      const filled = Math.round(Math.max(0, Math.min(1, share)) * barWidth)
      return (
        <Box flexDirection="row">
          <Text>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(barWidth - filled)}</Text>
        </Box>
      )
    }
    // 圖的寬度刻意估大（一格算 10 像素），桌面版縮到欄寬，長條就填滿整欄、粗細在各種欄寬下差不多
    const byKind = (parts: Amount[], total: number) => {
      const shown = parts.filter((p) => p.usd > 0)
      if (Svg === null) {
        return shown.map((p) => (
          <Box flexDirection="column">
            {line(p.label, `${usd(p.usd)}  ${pct(p.usd, total)}`)}
            {bar(total > 0 ? p.usd / total : 0)}
          </Box>
        ))
      }
      return [
        <Svg
          source={stackedBar(shown, Math.max(200, e.props.bodyColumns * 10))}
          alt={shown.map((p) => `${p.label} ${pct(p.usd, total)}`).join('、')}
        />,
        ...shown.map((p) => (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={swatch(p.label)} alt={p.label} width={10} height={10} />
            <Box flexGrow={1} flexDirection="column">
              {line(p.label, `${usd(p.usd)}  ${pct(p.usd, total)}`)}
            </Box>
          </Box>
        )),
      ]
    }
    const section = (title: string, list: Amount[]) =>
      list.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold>{title}</Text>
          {list.map((a) => line(a.label, usd(a.usd)))}
        </Box>
      )

    const tabs = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button
          key="tab-session"
          label="這個 session"
          hotkey="s"
          variant={showsPr ? 'secondary' : 'primary'}
          onPress={() => update($, ledgerView, () => 'session')}
        />
        {pr !== null || isLoading ? (
          <Button
            key="tab-pr"
            label={pr !== null ? `PR #${pr.number}` : 'PR'}
            hotkey="p"
            variant={showsPr ? 'primary' : 'secondary'}
            onPress={() => update($, ledgerView, () => 'pr')}
          />
        ) : null}
      </Box>
    )

    if (s === null || (showsPr && isLoading)) {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>{isLoading ? '正在讀所有 session 的帳……' : '還沒查過 PR。打 /ledger pr <編號>。'}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box flexDirection="column">
          <Text bold>{`${s.title}　${usd(s.totalUsd)}`}</Text>
          <Text dimColor>{`${s.sessions} 個 session · ${s.requests} 次請求 · 定價表 ${PRICE_TABLE}`}</Text>
          {s.speed.latest === null || s.speed.average === null ? null : (
            <Text dimColor>{`輸出速度：最近 ${tps(s.speed.latest)} · 平均 ${tps(s.speed.average)}`}</Text>
          )}
          {s.firstToken.latest === null || s.firstToken.average === null ? null : (
            <Text dimColor>{`首字時間：最近 ${secs(s.firstToken.latest)} · 平均 ${secs(s.firstToken.average)}`}</Text>
          )}
        </Box>
        {s.requests === 0 ? (
          <Text dimColor>還沒有紀錄：mod 載入之後的請求才會記帳。</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text bold>依 token 種類</Text>
              {byKind(s.parts, s.totalUsd)}
            </Box>
            {section('依來源', s.bySource)}
            {s.byModel.length === 0 ? null : (
              <Box flexDirection="column">
                <Text bold>依模型</Text>
                {s.byModel.map((a) => line(shortModel(a.label), [usd(a.usd), ...timingOf(a)].join(' · ')))}
              </Box>
            )}
            {section('依歸屬', s.byTarget)}
            {s.recent.length === 0 ? null : (
              <Box flexDirection="column">
                <Text bold>最近的請求</Text>
                {s.recent.map((r) =>
                  line(
                    `${r.source} · ${r.model}`,
                    [
                      r.usd === null ? '—' : usd(r.usd),
                      `${Math.round(r.contextTokens / 1000)}k`,
                      ...(r.tokensPerSecond === null ? [] : [tps(r.tokensPerSecond)]),
                    ].join(' · '),
                    true,
                  ),
                )}
              </Box>
            )}
          </Box>
        )}
        <Box flexDirection="column">
          {s.unpriced > 0 ? <Text dimColor>{`有 ${s.unpriced} 次請求的模型不在定價表裡，沒算進金額。`}</Text> : null}
          {s.notes.map((n) => (
            <Text dimColor>{n}</Text>
          ))}
          {s.speed.average === null ? null : <Text dimColor>{SPEED_NOTE}</Text>}
          {s.firstToken.average === null ? null : <Text dimColor>{TTFT_NOTE}</Text>}
          <Text dimColor>{ASSUMPTION}</Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            key="copy"
            label="複製 markdown"
            hotkey="c"
            onPress={async (press) => {
              const current = (await read($, ledgerView)) === 'pr' ? (await read($, prLedger))?.summary : await read($, sessionLedger)
              if (!current) return
              const copied = await $.ui.copy({ text: format(current), surface: press.surface })
              $.ui.toast(copied.isCopied ? 'cost-ledger：已複製，可以貼進 PR 內文' : 'cost-ledger：複製失敗')
            }}
          />
          {showsPr && pr !== null ? (
            <Button key="refresh-pr" label="重算這支 PR" hotkey="r" onPress={() => loadPr($, pr.number)} />
          ) : null}
        </Box>
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    await flush($)
    // /clear、/resume 之後是新的 session id，下一筆重新取
    sessionId = ''
    sessionRows = []
    fileText.clear()
    return next(e)
  })
}
