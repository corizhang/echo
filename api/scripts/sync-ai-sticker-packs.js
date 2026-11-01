import pg from 'pg'
import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, copyFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const root = resolve(process.env.ECHO_AI_STICKER_PACK_DIR || '/app/ai-sticker-packs')
const uploadRoot = resolve(process.env.ECHO_UPLOAD_DIR || '/app/uploads')
const mimeByExt = new Map([['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.gif','image/gif'],['.webp','image/webp']])
const matches = {
  'image/png': (b) => b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
  'image/jpeg': (b) => b[0] === 255 && b[1] === 216 && b.at(-2) === 255 && b.at(-1) === 217,
  'image/gif': (b) => ['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)),
  'image/webp': (b) => b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP',
}
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0,40)
const packs = await readdir(root, { withFileTypes: true }).catch((error) => { console.error(`Cannot read ${root}: ${error.message}`); process.exit(2) })
const client = await pool.connect()
let synced = 0
try {
  await mkdir(uploadRoot, { recursive: true })
  for (const folder of packs.filter((item) => item.isDirectory())) {
    const agentId = folder.name
    const file = join(root, agentId, 'manifest.json')
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    if (manifest.agentId !== agentId || !/^[a-zA-Z0-9_-]{1,80}$/.test(agentId)) throw new Error(`${file}: agentId must match the folder name`)
    const agent = await client.query('SELECT id,server_id FROM ai_agents WHERE id=$1', [agentId])
    if (!agent.rowCount) throw new Error(`AI agent not found: ${agentId}`)
    const groups = Array.isArray(manifest.groups) ? manifest.groups : []
    const expected = []
    for (const group of groups) {
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(group.key || '') || !/^[a-zA-Z0-9_-]{1,48}$/.test(group.emotion || '') || !String(group.name || '').trim() || [...group.name].length > 32) throw new Error(`${file}: invalid group key/emotion/name`)
      const groupId = `aistg-group-${hash(`${agentId}:${group.key}`)}`
      await client.query(`INSERT INTO ai_agent_sticker_groups(id,agent_id,server_id,group_key,emotion,name,scope) VALUES($1,$2,$3,$4,$5,$6,'agent')
        ON CONFLICT(agent_id,group_key) DO UPDATE SET server_id=EXCLUDED.server_id,emotion=EXCLUDED.emotion,name=EXCLUDED.name`, [groupId, agentId, agent.rows[0].server_id, group.key, group.emotion, group.name.trim()])
      for (const item of Array.isArray(group.items) ? group.items : []) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.key || '') || !String(item.name || '').trim() || [...item.name].length > 40) throw new Error(`${file}: invalid sticker key/name`)
        const imageName = basename(String(item.file || ''))
        if (!imageName || imageName !== item.file || imageName.startsWith('.')) throw new Error(`${file}: unsafe image file name ${item.file}`)
        const imagePath = resolve(root, agentId, imageName)
        const folderPath = resolve(root, agentId)
        if (!imagePath.startsWith(folderPath + '\\') && !imagePath.startsWith(folderPath + '/')) throw new Error(`image path escapes pack: ${imageName}`)
        const data = await readFile(imagePath); const mime = mimeByExt.get(extname(imageName).toLowerCase())
        if (!mime || !matches[mime](data) || data.length > 2*1024*1024) throw new Error(`unsupported, invalid or >2MB image: ${imagePath}`)
        const key = `${group.key}:${item.key}`
        const id = `aistg-${hash(`${agentId}:${key}`)}`
        const storageKey = `botsticker-${hash(`${agentId}:${key}`)}${mime === 'image/jpeg' ? '.jpg' : extname(imageName).toLowerCase()}`
        await copyFile(imagePath, join(uploadRoot, storageKey))
        await client.query(`INSERT INTO ai_agent_stickers(id,agent_id,group_id,sticker_key,name,description,mime_type,size_bytes,storage_key,is_active)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
          ON CONFLICT(agent_id,sticker_key) DO UPDATE SET group_id=EXCLUDED.group_id,name=EXCLUDED.name,description=EXCLUDED.description,mime_type=EXCLUDED.mime_type,size_bytes=EXCLUDED.size_bytes,storage_key=EXCLUDED.storage_key,is_active=true`,
        [id, agentId, groupId, key, item.name.trim(), String(item.description || '').trim().slice(0,240), mime, data.length, storageKey])
        expected.push(key); synced++
      }
    }
    await client.query(`UPDATE ai_agent_stickers SET is_active=false WHERE agent_id=$1 AND is_active=true AND NOT (sticker_key=ANY($2::text[]))`, [agentId, expected])
    console.log(`Synced ${agentId}: ${groups.length} emotion groups, ${expected.length} stickers`)
  }
  console.log(`Done. ${synced} bot sticker assets processed.`)
} finally { client.release(); await pool.end() }
