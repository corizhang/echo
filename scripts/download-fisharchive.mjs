import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const sourceUrl = 'https://fisharchive.cc/stickers/index.json'
const outputDir = resolve(process.argv[2] || 'sticker-imports/fisharchive')
const concurrency = 6

function safeAssetUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'fisharchive.cc') throw new Error(`Refusing unexpected asset URL: ${value}`)
  return url
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Echo-Sticker-Archive-Importer/1.0', Accept: 'application/json,image/webp,image/*' }, signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 800))
    }
  }
  throw lastError
}

const indexResponse = await fetchWithRetry(sourceUrl)
const archive = await indexResponse.json()
if (!Array.isArray(archive.stickers) || archive.stickers.length !== archive.count) throw new Error('Archive index count does not match the sticker list')
await mkdir(join(outputDir, 'images'), { recursive: true })
const results = new Array(archive.stickers.length)
let nextIndex = 0
let finished = 0

async function worker() {
  while (true) {
    const index = nextIndex++
    if (index >= archive.stickers.length) return
    const item = archive.stickers[index]
    try {
      const imageUrl = safeAssetUrl(item.large || item.original)
      const response = await fetchWithRetry(imageUrl.toString())
      const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase()
      if (!contentType.startsWith('image/')) throw new Error(`Unexpected content type: ${contentType || 'missing'}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length) throw new Error('Empty image response')
      const extension = imageUrl.pathname.toLowerCase().endsWith('.gif') ? '.gif' : '.webp'
      const localFile = `${String(index + 1).padStart(3, '0')}-${basename(imageUrl.pathname).replace(/\.[^.]+$/, '')}${extension}`
      await writeFile(join(outputDir, 'images', localFile), bytes)
      results[index] = { ...item, localFile, downloadedFrom: imageUrl.toString(), contentType, sizeBytes: bytes.length }
    } catch (error) {
      results[index] = { ...item, localFile: null, downloadError: error.message }
    }
    finished += 1
    if (finished % 10 === 0 || finished === archive.stickers.length) console.log(`Downloaded ${finished}/${archive.stickers.length}`)
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, archive.stickers.length) }, worker))
const downloaded = results.filter((item) => item.localFile).length
const metadata = {
  source: archive.site || 'https://fisharchive.cc/',
  sourceIndex: sourceUrl,
  license: archive.license,
  note: '单张作品权利可能归不同创作者；此目录仅作本地筛选，未核实逐张授权。每张图片保留原始 alt、tags 与来源 URL。',
  count: archive.count,
  downloaded,
  failed: results.length - downloaded,
  stickers: results,
}
await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
await writeFile(join(outputDir, 'README.txt'), [
  'FishArchive sticker staging download',
  `Source: ${sourceUrl}`,
  `Downloaded: ${downloaded}/${archive.count}`,
  'Images are stored as provided by the site large-image endpoints (usually WebP).',
  'manifest.json preserves alt text, tags, dimensions, original and source URLs.',
  'Review rights and select assets before importing into Echo. This folder is git-ignored.',
].join('\n') + '\n', 'utf8')
const embeddedMetadata = JSON.stringify(metadata).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
const reviewPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FishArchive 表情筛选</title>
<style>
:root{color-scheme:dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#17181d;color:#e7e8ec}*{box-sizing:border-box}body{margin:0}.top{position:sticky;top:0;z-index:2;padding:18px clamp(14px,3vw,36px);background:#202127f2;backdrop-filter:blur(10px);border-bottom:1px solid #ffffff14}.top h1{margin:0 0 5px;font-size:19px}.top p{margin:0;color:#a9acb6;font-size:12px}.tools{display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap}.tools input{flex:1;min-width:190px;height:36px;padding:0 11px;color:#eee;background:#15161b;border:1px solid #ffffff1c;border-radius:7px}.tools button,.tag{height:32px;padding:0 11px;color:#dfe0e6;background:#30323a;border:0;border-radius:6px;cursor:pointer}.tools button:hover,.tag:hover{background:#41434d}.tools #export{background:#6d5ce7;color:#fff}.filters{display:flex;gap:6px;overflow:auto;padding:12px 0 0}.tag{height:27px;white-space:nowrap;font-size:11px}.tag.active{background:#6d5ce7;color:white}.status{margin-left:auto;color:#b6b8c1;font-size:11px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:12px;padding:18px clamp(12px,2vw,28px)}.card{position:relative;display:flex;flex-direction:column;min-width:0;border:1px solid #ffffff14;border-radius:9px;background:#22242a;overflow:hidden}.card.selected{border-color:#8f7fff;box-shadow:0 0 0 1px #8f7fff55}.preview{height:210px;display:grid;place-items:center;background:#191a20;padding:8px;cursor:zoom-in}.preview img{max-width:100%;max-height:100%;object-fit:contain}.info{padding:9px}.caption{min-height:34px;margin:0 0 8px;color:#dcdee6;font-size:11px;line-height:1.5}.tags{display:flex;gap:4px;flex-wrap:wrap}.tag-small{padding:3px 6px;color:#b7b1e9;background:#7062d322;border-radius:10px;font-size:9px}.pick{position:absolute;top:8px;right:8px;width:25px;height:25px;accent-color:#7967ee;cursor:pointer}.id{position:absolute;top:10px;left:9px;padding:2px 5px;color:#eee;background:#0009;border-radius:4px;font-size:9px}.empty{padding:50px;text-align:center;color:#aeb0b8}.lightbox{position:fixed;inset:0;z-index:5;display:none;place-items:center;padding:20px;background:#000d}.lightbox.open{display:grid}.lightbox img{max-width:90vw;max-height:85vh;object-fit:contain}.lightbox button{position:absolute;top:18px;right:18px;width:40px;height:40px;border:0;border-radius:20px;background:#333;color:white;font-size:22px;cursor:pointer}@media(max-width:500px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:10px}.preview{height:170px}}
</style></head><body>
<header class="top"><h1>FishArchive 表情筛选 · ${metadata.count} 张</h1><p>图片仅保存在本机。勾选后可导出筛选清单；来源、标签与原始描述会保留。</p><div class="tools"><input id="q" type="search" placeholder="搜索描述或标签"><button id="select-visible">全选当前结果</button><button id="clear">清除选择</button><button id="export">导出已选清单</button><span class="status" id="status"></span></div><div class="filters" id="filters"></div></header>
<main class="grid" id="grid"></main><div class="lightbox" id="lightbox"><button aria-label="关闭">×</button><img alt=""></div>
<script>const data=${embeddedMetadata};const selected=new Set();let tag='';const grid=document.querySelector('#grid'),q=document.querySelector('#q'),status=document.querySelector('#status');const allTags=[...new Set(data.stickers.flatMap(x=>x.tags||[]))].sort((a,b)=>a.localeCompare(b,'zh-CN'));const filters=document.querySelector('#filters');function renderFilters(){filters.replaceChildren();for(const label of ['全部',...allTags]){const b=document.createElement('button');b.className='tag'+((label==='全部'&&!tag||label===tag)?' active':'');b.textContent=label;b.onclick=()=>{tag=label==='全部'?'':label;renderFilters();render()};filters.append(b)}}function render(){const query=q.value.trim().toLocaleLowerCase();const items=data.stickers.map((item,index)=>({...item,index})).filter(x=>(!tag||(x.tags||[]).includes(tag))&&(!query||x.alt.toLocaleLowerCase().includes(query)||(x.tags||[]).some(t=>t.toLocaleLowerCase().includes(query))));grid.replaceChildren();if(!items.length){const e=document.createElement('div');e.className='empty';e.textContent='没有匹配图片';grid.append(e)}for(const item of items){const card=document.createElement('article');card.className='card'+(selected.has(item.index)?' selected':'');const preview=document.createElement('div');preview.className='preview';const img=document.createElement('img');img.loading='lazy';img.src='images/'+encodeURIComponent(item.localFile);img.alt=item.alt;preview.append(img);preview.onclick=()=>{const lb=document.querySelector('#lightbox'),large=lb.querySelector('img');large.src=img.src;large.alt=item.alt;lb.classList.add('open')};const id=document.createElement('span');id.className='id';id.textContent=String(item.index+1).padStart(3,'0');const check=document.createElement('input');check.type='checkbox';check.className='pick';check.checked=selected.has(item.index);check.setAttribute('aria-label','选择 '+item.alt);check.onchange=()=>{check.checked?selected.add(item.index):selected.delete(item.index);render()};const info=document.createElement('div');info.className='info';const caption=document.createElement('p');caption.className='caption';caption.textContent=item.alt;const tags=document.createElement('div');tags.className='tags';for(const t of item.tags||[]){const pill=document.createElement('span');pill.className='tag-small';pill.textContent=t;tags.append(pill)}info.append(caption,tags);card.append(preview,id,check,info);grid.append(card)}status.textContent='已选 '+selected.size+' 张 · 当前显示 '+items.length+' 张'}q.addEventListener('input',render);document.querySelector('#select-visible').onclick=()=>{const query=q.value.trim().toLocaleLowerCase();for(let i=0;i<data.stickers.length;i++){const item=data.stickers[i];if((!tag||(item.tags||[]).includes(tag))&&(!query||item.alt.toLocaleLowerCase().includes(query)||(item.tags||[]).some(t=>t.toLocaleLowerCase().includes(query))))selected.add(i)}render()};document.querySelector('#clear').onclick=()=>{selected.clear();render()};document.querySelector('#export').onclick=()=>{const stickers=data.stickers.filter((_,i)=>selected.has(i));if(!stickers.length)return;const result={source:data.source,sourceIndex:data.sourceIndex,license:data.license,count:stickers.length,stickers};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));a.download='fisharchive-selected.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};const lb=document.querySelector('#lightbox');lb.onclick=e=>{if(e.target===lb||e.target.tagName==='BUTTON')lb.classList.remove('open')};document.addEventListener('keydown',e=>{if(e.key==='Escape')lb.classList.remove('open')});renderFilters();render()</script></body></html>`
await writeFile(join(outputDir, 'review.html'), reviewPage, 'utf8')
console.log(`Finished: ${downloaded}/${archive.count} images saved in ${outputDir}`)
