// 一個任務：使用者打一段話開始，到主對話那一輪結束；背景工作做完接著跑的那一輪（沒有打字）算同一個任務
export type TaskStatus = 'running' | 'done' | 'aborted' | 'error'

// 一次宣告：整個任務預計的主對話工具呼叫次數與總花費（美元，含子 agent）
export type Declared = { toolCalls: number; costUsd: number }

export type Estimate = {
  // Claude 第一次宣告的，校正倍率照這個算
  first: Declared
  // 最近一次宣告的；沒改過就跟 first 一樣
  latest: Declared
  revisions: number
  // Claude 用一句話說這個任務要做什麼
  summary: string
  // 套上的校正倍率（實際 ÷ 預估的中位數）；紀錄不夠、或 Claude 改過預估時是 null
  factor: Declared | null
  // 面板拿來當分母的數字：沒改過時是第一次宣告乘上倍率，改過之後直接用最新的宣告
  target: Declared
}

// 主對話正在跑的工具
export type RunningTool = { id: string; label: string }

// 主對話跑完的工具；最新的在前
export type RecentTool = { label: string; ms: number; isError: boolean }

export type Task = {
  id: string
  prompt: string
  status: TaskStatus
  startedAt: number
  endedAt: number | null
  // 開始時 session 的累計花費；宿主沒有花費帳時兩個都是 null
  costAtStart: number | null
  costUsd: number | null
  // 主對話跑完的工具呼叫（不含 estimate 自己），進度照這個算
  toolCalls: number
  // 子 agent 的工具呼叫，只列出來、不算進進度
  agentToolCalls: number
  running: RunningTool[]
  recent: RecentTool[]
  estimate: Estimate | null
}

// 做完一個有預估的任務記一筆；最新的在前
export type HistoryEntry = {
  id: string
  endedAt: number
  title: string
  status: TaskStatus
  estimate: Declared
  // 最後一次修正的；沒改過是 null
  revised: Declared | null
  actual: { toolCalls: number; costUsd: number | null; durationMs: number }
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      // 目前或最近一個任務；還沒有任何任務、或 /clear 之後是 null
      task: Task | null
      // 任務進行中每秒更新一次，卡片的經過時間、轉圈、預估剩餘時間跟著它重畫
      now: number
      history: HistoryEntry[]
    }
  }
}
