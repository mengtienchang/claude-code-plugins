# claude-code-plugins

自己寫的 Claude Code 插件，一個資料夾一個插件。

| 插件 | 做什麼 |
| --- | --- |
| [cost-ledger](cost-ledger/) | 每次模型請求逐筆記帳：四種 token 的金額、輸出速度與首字時間、歸屬到哪支 PR；輸入框上方常駐一張卡片，點一下開側邊面板看詳細 |
| [task-progress](task-progress/) | 交代任務時 Claude 先預估工具次數與花費，輸入框上方即時顯示做到幾 %、經過時間、正在跑的工具；做完把預估與實際記下來，校正下一次的預估 |
| [md-viewer](md-viewer/) | 在側邊窗格渲染 Markdown：mermaid 與內嵌 SVG 畫成圖、VitePress 的容器與 `<details>` 轉成引用、相對連結點了就在窗格裡換頁、存檔就刷新；`/md <路徑>` 開檔，也會跟著 Claude 正在改的 md 換過去 |

## 安裝

這些插件用 function hooks 寫成，從本機資料夾載入。clone 下來之後，在 `~/.claude/settings.json` 的 `env` 加上：

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "CLAUDE_CODE_PLUGIN_DIRS": "~/path/to/claude-code-plugins/cost-ledger:~/path/to/claude-code-plugins/task-progress"
  }
}
```

`CLAUDE_CODE_PLUGIN_DIRS` 放插件資料夾的絕對路徑（可以用 `~`），好幾個用 `:` 隔開。終端機裡只想試一次的話，用 `claude --plugin-dir <插件資料夾>`。

終端機的互動 session 會盯著這些資料夾，存檔就重新載入；桌面版開的 session 要開新的才會載入改動。

## 開發

每個插件資料夾裡：

```bash
claude plugin validate <插件資料夾>
```

```bash
claude plugin test <插件資料夾>
```

型別檢查用 `tsc -p <插件資料夾>`。插件的 `tsconfig.json` extends 的 `.claude-plugin/types/` 是引擎載入插件時產生的，不在版控裡，所以先讓 Claude Code 載入過一次再跑。
