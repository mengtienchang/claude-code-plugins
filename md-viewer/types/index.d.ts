/** 窗格目前的畫面：讀文件、看目錄、找檔案 */
export type MdViewerMode = 'doc' | 'toc' | 'open'

declare module 'claude-code' {
  interface PluginState {
    'md-viewer': {
      /** 目前開著的 md 絕對路徑；空字串＝還沒開檔 */
      file: string
      /** 目前在第幾頁（0 起算） */
      page: number
      /** 檔案改了或 mermaid 畫好了就加一，讓窗格重畫 */
      rev: number
      mode: MdViewerMode
      /** Claude 編輯或寫入 md 時，窗格跟著換到那份 */
      follow: boolean
      /** 最近開過的 md（新的在前），也存在 $.store 跨 session 保留 */
      recent: string[]
      /** 找檔案的搜尋字 */
      query: string
      /** 窗格頂端的狀態提示（mermaid 渲染進度、錯誤） */
      notice: string
    }
  }
}
