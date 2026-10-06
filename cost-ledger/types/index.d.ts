// 面板畫的東西：一份帳的摘要，照 token 種類、來源、模型、歸屬拆好的金額
export type Amount = { label: string; usd: number }

// 依模型的金額加上那個模型的平均輸出速度與平均首字時間（毫秒）；那個模型沒有一筆有計時的請求時是 null
export type ModelAmount = Amount & { tokensPerSecond: number | null; ttftMs: number | null }

export type RecentRequest = {
  source: string
  model: string
  usd: number | null
  contextTokens: number
  tokensPerSecond: number | null
}

// 輸出速度，token/s：最近一次有計時的請求，與全部有計時請求的總輸出除以總生成時間
export type Speed = { latest: number | null; average: number | null }

// 首字時間，毫秒：送出請求到第一個回應片段。最近一次有計時的請求，與全部有計時請求的直接平均
export type FirstToken = { latest: number | null; average: number | null }

export type Summary = {
  title: string
  sessions: number
  requests: number
  totalUsd: number
  parts: Amount[]
  bySource: Amount[]
  byModel: ModelAmount[]
  byTarget: Amount[]
  unpriced: number
  notes: string[]
  // 最新的在前
  recent: RecentRequest[]
  speed: Speed
  firstToken: FirstToken
}

export type PrLedger = { number: number; summary: Summary }

export type LedgerView = 'session' | 'pr'

declare module 'claude-code' {
  interface PluginState {
    'cost-ledger': {
      // 這個 session 的帳，每次請求後即時更新
      session: Summary
      // /ledger pr <編號> 查的那支 PR，查的當下的快照
      pr: PrLedger | null
      view: LedgerView
      // PR 那份正在重算
      isLoading: boolean
    }
  }
}
