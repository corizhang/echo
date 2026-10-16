import pg from 'pg'
import { randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { emitKeypressEvents } from 'node:readline'
import { promisify } from 'node:util'

const { Pool } = pg
const scrypt = promisify(scryptCallback)
const [rawUsername, rawDisplayName] = process.argv.slice(2)
const username = String(rawUsername || '').trim().toLowerCase()
const displayName = String(rawDisplayName || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 32)

if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
  console.error('用户名需为 3–32 位小写字母、数字、点、下划线或短横线，并以字母或数字开头。')
  process.exit(2)
}
if (!displayName) {
  console.error('请提供 1–32 个字符的显示名称。')
  process.exit(2)
}
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.error('请通过交互式终端执行，以便安全输入密码。')
  process.exit(2)
}
emitKeypressEvents(process.stdin)

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    let value = ''
    process.stdout.write(prompt)
    input.setRawMode(true)
    input.resume()
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        process.stdout.write('\n')
        cleanup()
        reject(new Error('已取消。'))
      } else if (key.name === 'return' || key.name === 'enter') {
        process.stdout.write('\n')
        cleanup()
        resolve(value)
      } else if (key.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('')
      } else if (character && !key.ctrl && !key.meta) {
        value += character
      }
    }
    function cleanup() {
      input.off('keypress', onKeypress)
      input.setRawMode(false)
    }
    input.on('keypress', onKeypress)
  })
}

let password
try {
  password = await readHidden('设置密码（至少 16 位，不会显示）: ')
  const confirmation = await readHidden('再次输入密码: ')
  if (password.length < 16) throw new Error('密码至少需要 16 个字符。')
  if (password !== confirmation) throw new Error('两次输入的密码不一致。')
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

const salt = randomBytes(16)
const derivedKey = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
const passwordHash = `scrypt$16384$${salt.toString('base64url')}$${Buffer.from(derivedKey).toString('base64url')}`
password = ''

const db = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await db.connect()
const id = `user-${username}`
try {
  await client.query('BEGIN')
  await client.query(
    `INSERT INTO users(id, username, display_name, avatar, color, status, activity, password_hash)
     VALUES($1, $2, $3, $4, 'blue', 'offline', NULL, $5)`,
    [id, username, displayName, Array.from(displayName)[0], passwordHash],
  )
  await client.query('INSERT INTO server_members(server_id, user_id) VALUES($1, $2)', ['server-squad', id])
  await client.query('COMMIT')
  console.log(`账号已创建：${username}（${displayName}），已加入“游戏小队”。`)
} catch (error) {
  await client.query('ROLLBACK')
  if (error.code === '23505') {
    console.error(`用户名或账号 ID 已存在：${username}。为避免覆盖现有账号，本次未修改数据。`)
  } else if (error.code === '23503') {
    console.error('找不到默认小队 server-squad；请先确认 Echo 数据库初始化完成。')
  } else {
    console.error(`创建失败：${error.message}`)
  }
  process.exitCode = 1
} finally {
  client.release()
  await db.end()
}
