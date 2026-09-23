import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../bin/eggox.mjs', import.meta.url))

function run(args, env, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

const report = {
  ok: false, room: 'Hub', seconds: 1.2, errors: 1, limits: [],
  failures: [{ expect: 'save visits = 2', got: 'visits is 1' }],
  saves: { player: { visits: 1 }, game: {} },
  steps: [
    { step: 'enter Hub', at_ms: 90, events: [
      { kind: 'log', room: 'Hub', source: 'room', text: 'started' },
      { kind: 'set_state', room: 'Hub', source: 'room', thing: 'placed_1', name: 'Kettle', state: 'boil' },
      { kind: 'floor', room: 'Hub', source: 'room', tile: [1, 1], color: '#fff' },
      { kind: 'floor', room: 'Hub', source: 'room', tile: [1, 2], color: '#fff' },
      { kind: 'window', room: 'Hub', source: 'room', spec: { id: 'shop', title: 'SHOP', text: 'Pick one.\nOr leave.', items: [{ kind: 'button', id: 'tea', label: 'TEA' }, { kind: 'input', id: 'name' }] } },
    ] },
    { step: 'walk 4,7', at_ms: 300, room: 'Hub', at: [4, 7], events: [] },
    { step: 'expect save visits = 2', at_ms: 310, room: 'Hub', at: [4, 7], events: [
      { kind: 'expect', ok: false, text: 'save visits = 2', got: 'visits is 1' },
    ] },
    { step: 'key space', at_ms: 400, events: [
      { kind: 'diagnostic', level: 'error', room: 'Hub', text: 'room: key: error: boom' },
      { kind: 'entered', room: 'Brew Room' },
    ] },
  ],
}

test('playtest prints the steps and errors, logs reads the last run, MCP has both', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eggox-playtest-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'eggox.json'), JSON.stringify({ id: 'room:tpi_k', name: 'Kettle & Moss' }))
  fs.writeFileSync(path.join(dir, 'walk.txt'), 'click Kettle\nkey space\n')
  const bodies = []

  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST' && req.url === '/api/dev/games/tpi_k/playtest') {
      let body = ''
      for await (const part of req) body += part
      bodies.push(JSON.parse(body))
      return res.end(JSON.stringify(report))
    }
    if (req.method === 'GET' && req.url === '/api/dev/games/tpi_k/logs') {
      return res.end(JSON.stringify({ ok: true, run: { room: 'Hub', headless: false, started_at: 0, entries: [{ at: 1000, level: 'error', room: 'Hub', message: 'room: enter: error: nope' }] } }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const env = { ...process.env, EGGOX_TOKEN: 't', EGGOX_SERVER: `http://127.0.0.1:${server.address().port}`, EGGOX_HOME: dir }

  fs.writeFileSync(path.join(dir, 'saves.json'), JSON.stringify({ player: { coins: 5 }, game: { best: 1 } }))
  let r = await run(['playtest', dir, '--steps', 'key space', '--room', 'Hub', '--reset', '--saves', path.join(dir, 'saves.json'), '--save', 'visits=4', '--save', 'name=Ada', '--game-save', 'best={"n":2}', '--seed', '7'], env)
  assert.equal(r.code, 1, 'errors in the run make the exit code 1')
  assert.deepEqual(bodies[0], { steps: 'key space', room: 'Hub', reset: true, seed: 7, saves: { player: { coins: 5, visits: 4, name: 'Ada' }, game: { best: { n: 2 } } } })
  assert.match(r.stdout, /1 expectation failed/)
  assert.match(r.stdout, /window \[Hub\] #shop "SHOP" "Pick one\. \/ Or leave\." \[tea "TEA", input name\]/)
  assert.match(r.stdout, /walk 4,7  \(\+0\.30 s\)  Hub 4,7\n  \(nothing happened\)/)
  assert.match(r.stdout, /FAILED: expect save visits = 2 \(visits is 1\)/)
  assert.match(r.stdout, /Failed:\n  expect save visits = 2: visits is 1/)
  assert.match(r.stdout, /Playtest of Hub: 1.2 s, 1 error, 1 expectation failed\./)
  assert.match(r.stdout, /set_state \[Hub\] Kettle \(placed_1\) → boil/)
  assert.match(r.stdout, /floor: 2 tiles painted/)
  assert.match(r.stdout, /ERROR \[Hub\] room: key: error: boom/)
  assert.match(r.stdout, /→ entered Brew Room/)
  assert.match(r.stdout, /Saved for the player: \{"visits":1\}/)

  r = await run(['playtest', dir, '--script', path.join(dir, 'walk.txt')], env)
  assert.equal(bodies[1].steps, 'click Kettle\nkey space\n')

  r = await run(['logs', dir], env)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Playtest of Hub/)
  assert.match(r.stdout, /ERROR \[Hub\] room: enter: error: nope/)

  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'eggox_playtest', arguments: { dir, steps: [{ key: 'space' }], seed: 3, saves: { player: { visits: 1 } } } } },
  ]
  r = await run(['mcp'], env, calls.map((c) => JSON.stringify(c)).join('\n') + '\n')
  const replies = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
  const names = replies[0].result.tools.map((x) => x.name)
  assert(names.includes('eggox_playtest') && names.includes('eggox_logs'))
  assert.deepEqual(bodies[2].steps, [{ key: 'space' }])
  assert.equal(bodies[2].seed, 3)
  assert.deepEqual(bodies[2].saves, { player: { visits: 1 } })
  assert.equal(r.code, 0, 'a failed run is an answer, not the MCP server failing')
  assert.equal(JSON.parse(replies[1].result.content[0].text).errors, 1)
})

test('stock use switches a version, and refusals are sentences', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eggox-stock-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'eggox.json'), JSON.stringify({ id: 'room:tpi_k', name: 'Kettle & Moss' }))
  const seen = []
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    let body = ''
    for await (const part of req) body += part
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
    if (req.url === '/api/dev/games/tpi_k/stock') return res.end(JSON.stringify({ stock: [{ id: 'it_1', name: 'Forest Kit', thing: 'Forest Kit', instances: 33, version: 1, versions: [2, 1], entrances: [], rooms: [{ name: 'Hub', count: 33 }] }] }))
    if (req.url === '/api/dev/games/tpi_k/stock/Forest%20Kit/version' && JSON.parse(body).version === 'latest') return res.end(JSON.stringify({ ok: true, thing: 'Forest Kit', version: 2, instances: 33 }))
    res.statusCode = 422
    res.end(JSON.stringify({ error: 'version', text: 'Forest Kit has no such published version; eggox stock lists the ones it has' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const env = { ...process.env, EGGOX_TOKEN: 't', EGGOX_SERVER: `http://127.0.0.1:${server.address().port}`, EGGOX_HOME: dir }

  let r = await run(['stock', dir], env)
  assert.match(r.stdout, /Forest Kit  \(33 standing: 33 in Hub, v1 of 1\/2\)/)
  r = await run(['stock', 'use', 'Forest Kit', 'latest', dir], env)
  assert.equal(r.code, 0)
  assert.match(r.stdout, /Forest Kit shows v2 now, with the 33 standing\./)
  r = await run(['stock', 'use', 'Forest Kit', '9', dir], env)
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /stock use refused: Forest Kit has no such published version/)
  r = await run(['stock', 'use', 'Forest Kit', 'newest', dir], env)
  assert.match(r.stderr, /usage: eggox stock use/)
})
