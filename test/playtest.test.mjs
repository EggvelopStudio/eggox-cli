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
  ok: true, room: 'Hub', seconds: 1.2, errors: 1, limits: [],
  saves: { player: { visits: 1 }, game: {} },
  steps: [
    { step: 'enter Hub', at_ms: 90, events: [
      { kind: 'log', room: 'Hub', source: 'room', text: 'started' },
      { kind: 'set_state', room: 'Hub', source: 'room', thing: 'placed_1', name: 'Kettle', state: 'boil' },
      { kind: 'floor', room: 'Hub', source: 'room', tile: [1, 1], color: '#fff' },
      { kind: 'floor', room: 'Hub', source: 'room', tile: [1, 2], color: '#fff' },
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

  let r = await run(['playtest', dir, '--steps', 'key space', '--room', 'Hub', '--reset'], env)
  assert.equal(r.code, 1, 'errors in the run make the exit code 1')
  assert.deepEqual(bodies[0], { steps: 'key space', room: 'Hub', reset: true })
  assert.match(r.stdout, /Playtest of Hub: 1.2 s, 1 error\./)
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
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'eggox_playtest', arguments: { dir, steps: [{ key: 'space' }] } } },
  ]
  r = await run(['mcp'], env, calls.map((c) => JSON.stringify(c)).join('\n') + '\n')
  const replies = r.stdout.trim().split('\n').map((l) => JSON.parse(l))
  const names = replies[0].result.tools.map((x) => x.name)
  assert(names.includes('eggox_playtest') && names.includes('eggox_logs'))
  assert.deepEqual(bodies[2].steps, [{ key: 'space' }])
  assert.equal(JSON.parse(replies[1].result.content[0].text).errors, 1)
})
