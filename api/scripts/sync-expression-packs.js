import pg from 'pg'
import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, copyFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const packRoot = resolve(process.env.ECHO_EXPRESSION_PACK_DIR || '/app/expression-packs')
const uploadRoot = resolve(process.env.ECHO_UPLOAD_DIR || '/app/uploads')
const mimeByExt = new Map([['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.gif','image/gif'],['.webp','image/webp']])
const matches = {
  'image/png': (b) => b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
  'image/jpeg': (b) => b[0] === 255 && b[1] === 216 && b.at(-2) === 255 && b.at(-1) === 217,
  'image/gif': (b) => ['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)),
  'image/webp': (b) => b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP',
}
const safeKey = (value) => createHash('sha256').update(value).digest('hex').slice(0,40)
const files = await readdir(packRoot, { withFileTypes: true }).catch((error) => { console.error(`Cannot read pack directory ${packRoot}: ${error.message}`); process.exit(2) })
const poolClient = await pool.connect()
let count = 0
try {
  await mkdir(uploadRoot, { recursive: true })
  for (const entry of files.filter((item) => item.isDirectory())) {
    const folder = entry.name
    const manifestPath = join(packRoot, folder, 'manifest.json')
    let manifest
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch (error) { throw new Error(`${manifestPath}: ${error.message}`) }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(manifest.serverId || '') || manifest.serverId !== folder) throw new Error(`manifest serverId must match folder name: ${folder}`)
    const server = await poolClient.query('SELECT 1 FROM servers WHERE id=$1', [manifest.serverId])
    if (!server.rowCount) throw new Error(`server does not exist: ${manifest.serverId}`)
    const groups = Array.isArray(manifest.groups) ? manifest.groups : []
    const expected = []
    for (const group of groups) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(group.key || '') || !['emoji','sticker'].includes(group.kind) || !String(group.name || '').trim() || [...group.name].length > 32) throw new Error(`invalid group entry in ${manifest.serverId}`)
      const groupKey = `${manifest.serverId}:${group.kind}:${group.key}`
      const groupId = `expr-builtin-group-${safeKey(groupKey)}`
      await poolClient.query(`INSERT INTO expression_groups(id,server_id,kind,name,source,scope,builtin_key) VALUES($1,$2,$3,$4,'builtin','system',$5)
        ON CONFLICT(builtin_key) DO UPDATE SET name=EXCLUDED.name,scope='system'`, [groupId, manifest.serverId, group.kind, group.name.trim(), groupKey])
      for (const item of (Array.isArray(group.items) ? group.items : [])) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.key || '') || !String(item.name || '').trim() || [...item.name].length > (group.kind === 'emoji' ? 32 : 40)) throw new Error(`invalid asset in group ${group.key}`)
        const fileName = basename(String(item.file || ''))
        if (!fileName || fileName !== item.file || fileName.startsWith('.')) throw new Error(`unsafe image path for ${item.key}`)
        const sourcePath = resolve(packRoot, folder, fileName)
        if (!sourcePath.startsWith(resolve(packRoot, folder) + '\\') && !sourcePath.startsWith(resolve(packRoot, folder) + '/')) throw new Error(`image path escapes pack directory: ${fileName}`)
        const image = await readFile(sourcePath)
        const mime = mimeByExt.get(extname(fileName).toLowerCase())
        const maxBytes = group.kind === 'emoji' ? 256*1024 : 2*1024*1024
        if (!mime || !matches[mime](image) || image.length > maxBytes) throw new Error(`unsupported, invalid or oversized image: ${sourcePath}`)
        const assetKey = `${groupKey}:${item.key}`
        const storageKey = `builtin-${safeKey(assetKey)}${mime === 'image/jpeg' ? '.jpg' : extname(fileName).toLowerCase()}`
        await copyFile(sourcePath, join(uploadRoot, storageKey))
        const id = `expr-builtin-${safeKey(assetKey)}`
        await poolClient.query(`INSERT INTO expression_assets(id,server_id,owner_user_id,kind,name,mime_type,size_bytes,storage_key,group_id,is_builtin,builtin_key,deleted_at,scope)
          VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,true,$9,NULL,'system')
          ON CONFLICT(builtin_key) DO UPDATE SET name=EXCLUDED.name,mime_type=EXCLUDED.mime_type,size_bytes=EXCLUDED.size_bytes,storage_key=EXCLUDED.storage_key,group_id=EXCLUDED.group_id,deleted_at=NULL,scope='system'`, [id, manifest.serverId, group.kind, item.name.trim(), mime, image.length, storageKey, groupId, assetKey])
        expected.push(assetKey); count++
      }
    }
    await poolClient.query(`UPDATE expression_assets SET deleted_at=now() WHERE server_id=$1 AND is_builtin=true AND deleted_at IS NULL AND NOT (builtin_key=ANY($2::text[]))`, [manifest.serverId, expected])
    console.log(`Synced ${manifest.serverId}: ${groups.length} groups, ${expected.length} assets`)
  }
  console.log(`Done. ${count} built-in assets processed.`)
} finally { poolClient.release(); await pool.end() }
