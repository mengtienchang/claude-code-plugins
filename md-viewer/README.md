# md-viewer

在側邊窗格裡把 Markdown 渲染出來看，邊改邊看。對 VitePress 文件特別照顧：mermaid 和內嵌的 `<svg>` 畫成圖，`::: warning`、`<details>` 這類語法轉成引用區塊，文件之間的相對連結點了就在窗格裡換頁。

## 怎麼開

- **`/md <路徑>`**：在窗格開那份 md。路徑可以是相對於工作目錄的、絕對的或 `~/` 開頭的，後面可以接 `#錨點` 直接跳到那一節。
- **`/md`**：不帶路徑就開窗格；還沒開過檔的話直接進找檔畫面。
- **找檔**：窗格上的「開檔」。輸入檔名或路徑片段（空白分隔好幾個字，每個字都要出現在路徑裡），檔名符合的排前面；按 Enter 開第一個，也可以直接貼一個路徑。沒輸入時列最近開過的 20 份，跨 session 保留。清單來自 `git ls-files`，所以 `.gitignore` 掉的檔案不在裡面。
- **跟著 Claude 的編輯**：Claude 用 Edit 或 Write 改了某份 md、窗格又開著的話，窗格就換到那份。「跟隨編輯」可以關掉，關掉之後改過的 md 只會記進最近開過。

## 窗格裡有什麼

- **文件／目錄／開檔** 三個分頁。目錄列出 h1–h3，點了跳到那一節。
- **返回**：點連結換了文件之後，回到上一份原本看的那一頁。
- **重新載入**：重讀檔案，畫失敗的 mermaid 再畫一次。
- **存檔就刷新**：每 1.5 秒看一次目前這份的修改時間，不管是誰改的。
- **分頁**：長文件會分頁，一頁大約兩萬五到四萬五千字，盡量在 h1／h2 換頁。窗格的元件有大小上限，整份塞進去會畫不出來。
- 窗格開著的時候，按鍵：`d` 文件、`t` 目錄、`o` 開檔、`u` 返回、`r` 重新載入、`f` 切換跟隨、`b`／`n` 上一頁／下一頁。

## 怎麼畫

窗格的 Markdown 元件跟 Claude 的回覆用同一套渲染：標題、清單、表格、程式碼區塊、連結都正常。它看不懂 HTML，連結也只認 http、https、file，所以插件會先把文件轉一遍：

- **mermaid**：插件環境沒有瀏覽器，借本機的 headless Chrome 跑專案裡的 mermaid（從那份 md 所在的目錄往上找 `node_modules/mermaid`），畫成 SVG 再交給窗格。一批圖大約一兩秒，結果存在 `~/.cache/claude-md-viewer/svg/`，圖的內容沒變就直接讀快取。語法錯的圖顯示錯誤訊息和原始碼。
- **內嵌的 `<svg>`**：直接畫成圖。窗格把 SVG 當圖片畫、沒有網頁的 CSS，所以插件會把 VitePress 的配色變數（`var(--vp-c-text-1)` 這些）換成預設主題的亮色值定義在圖上，補上 `xmlns` 和固有尺寸，HTML 才有的實體（`&nbsp;`）換成數字實體。
- **`::: info / warning / details`**、**`<details><summary>`**、**`<FoldColumn label="…">`**：轉成引用區塊，標題粗體放第一行。`<details>` 一律展開。
- **相對連結**：轉成 `file://` 絕對網址。指向 md 的和 `#錨點` 點了在窗格裡跳；指向程式碼或資料夾的交給介面自己開。錨點的比對跟 VitePress 的 slug 規則一樣（全形標點、重複標題加 `-1`、`{#自訂}`），也接受直接寫標題原文。
- **frontmatter** 放在最上面，用 YAML 程式碼區塊顯示。
- `<figure>`、`<div>` 這類只包一層的標籤拿掉；`<figcaption>` 變成斜體圖說；行內的 `<code>`、`<b>`、`<br>` 換成對應的 Markdown。

## 已知的限制

- 窗格不告訴插件現在是淺色還深色，圖一律鋪白底，深色介面裡會是一張張白卡。
- mermaid 要本機有 Chrome（或 Chromium、Edge、Brave），專案裡也要裝了 mermaid；缺一個就顯示原始碼。
- mermaid 11 的純 SVG 標籤遇到換行（`<br/>`）會出錯，那幾張改用 HTML 標籤（foreignObject）畫，要看介面願不願意畫 SVG 裡的 HTML。
- 本機圖片（`![](./x.png)`）畫不出來，改成一個點了能打開的連結。
- 文件站的互動元件（`<DesignChainMap />`、`<ContextBlockMap />` 這些）畫不出來，只留一行提示。整份是 HTML 排版的文件，HTML 會原樣顯示。
- 從目錄跳到某一節時，捲到那一節所在段落的開頭；h4 以下的標題不另起段落，會停在它上面那個 h1–h3 的開頭。
- 終端機畫不了 SVG，圖的位置只留一行文字。

## 檔案

| 檔案 | 內容 |
| --- | --- |
| `.claude-plugin/plugin.json` | 插件的名稱、版本、型別契約的位置 |
| `hooks/hooks.json` | 指向 hooks 模組 |
| `hooks/register.tsx` | 窗格、指令、跟隨編輯、背景刷新與 mermaid 的排程；所有用到 `$` 的地方都在這裡 |
| `hooks/parse.ts` | Markdown 切段與語法轉換、連結與錨點、分頁，純函數 |
| `hooks/svg.ts` | 內嵌 SVG 轉成當圖片畫得出來的 SVG，純函數 |
| `hooks/mermaid.ts` | 交給 headless Chrome 的頁面、Chrome 的參數、讀回結果，純函數 |
| `types/index.d.ts` | 窗格讀的 `$.state` 值的型別契約 |
| `tests/md-viewer.test.ts` | 用 `claude plugin test` 跑的測試，引擎那一側（檔案系統、session、git）都是替身 |
