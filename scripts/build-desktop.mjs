import { mkdir, copyFile, cp, writeFile, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const url = new URL(process.env.ECHO_SERVER_URL || 'http://localhost:8080')
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('ECHO_SERVER_URL must be an HTTP(S) origin')
const origin = url.origin
await mkdir('dist/desktop', { recursive: true })
for (const name of ['index.html', 'voice.js']) await copyFile(name, `dist/desktop/${name}`)
await cp('src', 'dist/desktop/src', { recursive: true })
await writeFile('dist/desktop/src/desktop-config.js', `window.EchoServerUrl = ${JSON.stringify(origin)};\n`)
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
const csp = config.app.security.csp.replace('http://localhost:8080 ws://localhost:8080', `${origin} ${origin.replace(/^http/, 'ws')}`)
const result = spawnSync('cargo', ['build', '--release', '--manifest-path', 'src-tauri/Cargo.toml'], { stdio: 'inherit', env: { ...process.env, ECHO_SERVER_URL: origin, TAURI_CONFIG: JSON.stringify({ app: { security: { csp } } }) } })
if (result.status === 0) {
  const directory = `dist/windows/${new Date().toISOString().replace(/[:.]/g, '-')}`
  await mkdir(directory, { recursive: true })
  await copyFile('src-tauri/target/release/echo-client.exe', `${directory}/Echo.exe`)
  console.log(`Desktop artifact: ${directory}/Echo.exe`)
}
process.exit(result.status ?? 1)
