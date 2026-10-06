/**
 * mermaid → SVG 的純函數部分：插件環境沒有 DOM，借本機的 headless Chrome 跑專案裡的 mermaid。
 *
 * 一批圖寫成一張 HTML，Chrome 用 --dump-dom 印出跑完的 DOM，結果夾在標記之間。
 * 實際起 Chrome、讀輸出的那段要用 $，在 register.tsx。
 */
import { dirname, toFileUrl } from './parse'

export type MermaidResult = { svg: string } | { error: string }

export const MERMAID_BEGIN = '@@MDV-BEGIN@@'
export const MERMAID_END = '@@MDV-END@@'

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** 從某個目錄往上，每一層的 node_modules/mermaid 位置（近的在前） */
export function mermaidCandidates(fromDir: string): string[] {
  const found: string[] = []
  let dir = fromDir
  for (let depth = 0; depth < 40; depth++) {
    found.push(`${dir === '/' ? '' : dir}/node_modules/mermaid/dist/mermaid.min.js`)
    if (dir === '/') break
    dir = dirname(dir)
  }
  return found
}

/**
 * 頁面腳本：逐張 render，結果 JSON 夾在標記之間。
 *
 * 先用純 SVG 的標籤（htmlLabels: false），窗格把 SVG 當圖片畫時最穩；mermaid 11 的純 SVG
 * 標籤遇到換行（<br/>）會丟 splitLineToFitWidth，那種圖退回 HTML 標籤（foreignObject）再畫一次。
 * 畫完量出固有尺寸、拿掉 max-width、鋪白底；座標四捨五入到一位小數、拿掉 data-points，
 * 大張的流程圖才塞得進 Svg 元件 131072 字的上限（實測 270KB → 106KB）。
 */
const PAGE_SCRIPT = String.raw`
(async () => {
  const items = JSON.parse(document.getElementById('data').textContent);
  const out = {};
  const GEOMETRY = ['d', 'points', 'transform', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'viewBox', 'dx', 'dy'];
  const round = value => value.replace(/-?\d+\.\d+/g, n => String(Math.round(parseFloat(n) * 10) / 10));
  const render = (id, code, htmlLabels) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'strict',
      htmlLabels,
      flowchart: { htmlLabels },
      fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", sans-serif',
    });
    return mermaid.render(id, code);
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      let rendered;
      try {
        rendered = await render('mdv' + i, item.code, false);
      } catch (plain) {
        try {
          rendered = await render('mdvh' + i, item.code, true);
        } catch {
          throw plain;
        }
      }
      // 用 HTML 解析器讀：HTML 標籤裡有沒關的 <br>，當 XML 讀會變成 parsererror；
      // 讀進來再用 XMLSerializer 輸出，就是當圖片也畫得出來的合法 XML
      const host = document.createElement('div');
      host.innerHTML = rendered.svg;
      const svg = host.querySelector('svg');
      if (!svg) throw new Error('mermaid 沒有產出 svg');
      for (const node of svg.querySelectorAll('*')) {
        node.removeAttribute('data-points');
        for (const name of GEOMETRY) {
          const value = node.getAttribute(name);
          if (value && /\d\.\d/.test(value)) node.setAttribute(name, round(value));
        }
      }
      const box = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      if (box.length === 4 && box[2] > 0 && box[3] > 0) {
        svg.setAttribute('width', String(Math.ceil(box[2])));
        svg.setAttribute('height', String(Math.ceil(box[3])));
      }
      svg.style.removeProperty('max-width');
      svg.style.setProperty('background', '#ffffff');
      const xml = new XMLSerializer().serializeToString(svg);
      if (!xml.startsWith('<svg')) throw new Error('mermaid 的輸出不是 svg');
      out[item.hash] = { svg: xml };
    } catch (err) {
      out[item.hash] = { error: String((err && err.message) || err) };
    }
  }
  const json = JSON.stringify(out).replace(/[<>&\u00a0]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  document.getElementById('out').textContent = '${MERMAID_BEGIN}' + json + '${MERMAID_END}';
})();
`

export function mermaidJobHtml(mermaidJs: string, items: readonly { hash: string; code: string }[]): string {
  const data = JSON.stringify(items).replace(/</g, '\\u003c')
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<pre id="out"></pre>',
    `<script type="application/json" id="data">${data}</script>`,
    `<script src="${toFileUrl(mermaidJs)}"></script>`,
    `<script>${PAGE_SCRIPT}</script>`,
    '</body></html>',
  ].join('\n')
}

/**
 * Chrome 的參數。--use-mock-keychain 免得 macOS 跳鑰匙圈；
 * 獨立的 profile 才不會跟使用者開著的 Chrome 搶鎖。
 */
export function chromeArgv(chrome: string, profile: string, job: string): string[] {
  return [
    chrome,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--no-service-autorun',
    `--user-data-dir=${profile}`,
    '--allow-file-access-from-files',
    '--virtual-time-budget=60000',
    '--dump-dom',
    toFileUrl(job),
  ]
}

/** 不信任的 JSON 值（Chrome 的輸出、磁碟快取）→ 結果；形狀不對給 undefined */
export function toMermaidResult(value: unknown): MermaidResult | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if ('svg' in value && typeof value.svg === 'string' && value.svg.startsWith('<svg')) return { svg: value.svg }
  if ('error' in value && typeof value.error === 'string') return { error: value.error }
  return undefined
}

/** 從 Chrome 印出的 DOM 取回結果；沒有完整標記（逾時、Chrome 沒跑完）就給空的 */
export function parseMermaidOutput(output: string): Record<string, MermaidResult> {
  const begin = output.indexOf(MERMAID_BEGIN)
  const end = output.indexOf(MERMAID_END)
  if (begin < 0 || end < begin) return {}
  try {
    const parsed: unknown = JSON.parse(output.slice(begin + MERMAID_BEGIN.length, end))
    if (parsed === null || typeof parsed !== 'object') return {}
    const results: Record<string, MermaidResult> = {}
    for (const [hash, value] of Object.entries(parsed)) {
      const result = toMermaidResult(value)
      if (result) results[hash] = result
    }
    return results
  } catch {
    return {}
  }
}
