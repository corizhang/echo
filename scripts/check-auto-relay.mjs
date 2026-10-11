import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source = readFileSync('src/relay-ui.js', 'utf8')
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function harness(ticket = async () => ({ ticket: 'test' }), delayedStop = false) {
  const events = new Map(), nodes = new Map(), calls = []
  let native = { phase: 'idle' }, stopping = 0
  const node = id => { if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, value: '', hidden: false }); return nodes.get(id) }
  const window = { __TAURI__: { core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]); if (cmd === 'start_relay') native = { roomId: args.roomId, role: 'guest', phase: 'waiting' }
    if (cmd === 'stop_relay') { if (delayedStop) stopping = 2; else native = { phase: 'idle' } }
    if (cmd === 'relay_status' && stopping && --stopping === 0) native = { phase: 'idle' }
    if (cmd === 'relay_status') return native
  } } }, EchoApi: { getGameRelayTicket: ticket }, EchoApp: { toast() {} },
    addEventListener: (name, fn) => events.set(name, fn), dispatchEvent() {} }
  vm.runInNewContext(source, { window, document: { querySelector: node }, localStorage: { getItem() {}, setItem() {} }, CustomEvent: class {}, setTimeout, setInterval() {} })
  return { calls, emit: (name, detail) => events.get(name)({ detail }), button: node('#relay-toggle') }
}
const h = harness()
h.emit('echo:room-context', { id: 'a', joined: true, role: 'player' }); await flush()
assert.equal(h.calls.filter(c => c[0] === 'start_relay').length, 1)
h.emit('echo:room-context', { id: 'a', joined: true, role: 'player' }); await flush()
assert.equal(h.calls.filter(c => c[0] === 'start_relay').length, 1)
await h.button.onclick(); h.emit('echo:room-context', { id: 'a', joined: true, role: 'player' }); await flush()
assert.equal(h.calls.filter(c => c[0] === 'start_relay').length, 1, 'manual pause must persist')
await h.button.onclick(); await flush()
assert.equal(h.calls.filter(c => c[0] === 'start_relay').length, 2)
h.emit('echo:room-left', 'a'); await flush()
assert.equal(h.calls.filter(c => c[0] === 'stop_relay').length, 2)
let resolve
const late = harness(() => new Promise(r => { resolve = r }))
late.emit('echo:room-context', { id: 'a', joined: true, role: 'host' }); await flush()
late.emit('echo:room-left', 'a'); resolve({ ticket: 'late' }); await flush()
assert.equal(late.calls.filter(c => c[0] === 'start_relay').length, 0, 'late ticket must not start abandoned room')
const failed = harness(async () => { throw new Error('offline') })
failed.emit('echo:room-context', { id: 'a', joined: true, role: 'host' }); await flush()
assert.equal(failed.button.textContent, '重试连接')
const delayed = harness(undefined, true)
delayed.emit('echo:room-context', { id: 'a', joined: true, role: 'player' }); await flush()
await delayed.button.onclick()
assert.equal(delayed.button.textContent, '连接联机', 'pause waits for asynchronous native shutdown')
const roleChange = harness()
roleChange.emit('echo:room-context', { id: 'a', joined: true, role: 'player' }); await flush()
roleChange.emit('echo:room-context', { id: 'a', joined: true, role: 'host' }); await flush()
assert.equal(roleChange.calls.filter(c => c[0] === 'stop_relay').length, 1)
assert.equal(roleChange.calls.filter(c => c[0] === 'start_relay').length, 2, 'host transfer reconnects once')
console.log('Auto relay lifecycle checks passed')
