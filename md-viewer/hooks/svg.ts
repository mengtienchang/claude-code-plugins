/**
 * 內嵌在 md 裡的 <svg> → 窗格的 Svg 元件畫得出來的獨立 SVG 文件。純函數。
 *
 * 窗格把 SVG 當圖片畫：沒有網頁的 CSS、只認 XML。所以要補 xmlns、
 * 把 VitePress 的配色變數（var(--vp-c-text-1)…）定義在 SVG 自己身上、
 * HTML 才有的具名實體換成數字實體、給一個固有尺寸（原本是 width:100%）。
 * 配色取 VitePress 預設主題的亮色值，底色鋪白，深色介面裡就是一張白卡。
 */

const VP_LIGHT = [
  '--vp-c-text-1:#3c3c43',
  '--vp-c-text-2:#67676c',
  '--vp-c-text-3:#929295',
  '--vp-c-divider:#e2e2e3',
  '--vp-c-gutter:#e2e2e3',
  '--vp-c-border:#c2c2c4',
  '--vp-c-bg:#ffffff',
  '--vp-c-bg-alt:#f6f6f7',
  '--vp-c-bg-elv:#ffffff',
  '--vp-c-bg-soft:#f6f6f7',
  '--vp-c-gray-1:#dddde3',
  '--vp-c-gray-soft:rgba(142,150,170,0.14)',
  '--vp-c-default-1:#dddde3',
  '--vp-c-default-soft:rgba(142,150,170,0.14)',
  '--vp-c-brand-1:#3451b2',
  '--vp-c-brand-2:#3a5ccc',
  '--vp-c-brand-soft:rgba(100,108,255,0.14)',
  '--vp-c-indigo-1:#3451b2',
  '--vp-c-indigo-soft:rgba(100,108,255,0.14)',
  '--vp-c-purple-1:#6f42c1',
  '--vp-c-purple-soft:rgba(159,122,234,0.14)',
  '--vp-c-green-1:#18794e',
  '--vp-c-green-soft:rgba(16,185,129,0.14)',
  '--vp-c-yellow-1:#915930',
  '--vp-c-yellow-soft:rgba(234,179,8,0.14)',
  '--vp-c-red-1:#b8272c',
  '--vp-c-red-soft:rgba(244,63,94,0.14)',
  "--vp-font-family-base:-apple-system,BlinkMacSystemFont,'PingFang TC','Noto Sans TC',ui-sans-serif,system-ui,sans-serif",
  "--vp-font-family-mono:ui-monospace,Menlo,Monaco,Consolas,'Courier New',monospace",
].join(';')

/** HTML 具名實體 → 數字實體；XML 只認 lt/gt/amp/quot/apos */
const ENTITIES: Record<string, number> = {
  nbsp: 160,
  ensp: 8194,
  emsp: 8195,
  thinsp: 8201,
  mdash: 8212,
  ndash: 8211,
  hellip: 8230,
  middot: 183,
  bull: 8226,
  times: 215,
  divide: 247,
  rarr: 8594,
  larr: 8592,
  uarr: 8593,
  darr: 8595,
  harr: 8596,
  rArr: 8658,
  lArr: 8656,
  hArr: 8660,
  le: 8804,
  ge: 8805,
  ne: 8800,
  plusmn: 177,
  deg: 176,
  copy: 169,
  reg: 174,
  laquo: 171,
  raquo: 187,
  lsquo: 8216,
  rsquo: 8217,
  ldquo: 8220,
  rdquo: 8221,
  check: 10003,
  cross: 10007,
}

const XML_ENTITIES = new Set(['lt', 'gt', 'amp', 'quot', 'apos'])

export function prepareInlineSvg(source: string): string {
  const open = /^<svg\b([^>]*?)(\/?)>/i.exec(source)
  if (!open) return source
  let attrs = open[1] ?? ''
  if (!/\sxmlns=/.test(attrs)) attrs = ` xmlns="http://www.w3.org/2000/svg"${attrs}`
  if (/xlink:/.test(source) && !/\sxmlns:xlink=/.test(attrs)) attrs = ` xmlns:xlink="http://www.w3.org/1999/xlink"${attrs}`

  const [, , , width, height] = /\sviewBox="\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(attrs) ?? []
  if (width && height && !/\swidth=/.test(attrs)) attrs += ` width="${width}" height="${height}"`

  // 根元素 style 裡撐滿版面的寬高拿掉，改用上面的固有尺寸；底色鋪白
  let hasStyle = false
  attrs = attrs.replace(/\sstyle="([^"]*)"/, (_, style: string) => {
    hasStyle = true
    const kept = style
      .split(';')
      .map(rule => rule.trim())
      .filter(rule => rule !== '' && !/^(width|height|max-width|max-height)\s*:/i.test(rule))
    kept.push('background:#ffffff')
    return ` style="${kept.join(';')}"`
  })
  if (!hasStyle) attrs += ' style="background:#ffffff"'

  const body = open[2] ? '</svg>' : source.slice(open[0].length)
  const fixed = body.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
    if (XML_ENTITIES.has(name)) return whole
    const code = ENTITIES[name]
    return code === undefined ? whole : `&#${code};`
  })
  return `<svg${attrs}><style>:root{${VP_LIGHT}}</style>${fixed}`
}
