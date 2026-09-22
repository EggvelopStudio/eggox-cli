import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../bin/eggox.mjs', import.meta.url))

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

test('a check names a renamed room and counts only the rooms nothing happened in', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eggox-report-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'eggox.json'), JSON.stringify({ id: 'room:tpi_k', name: 'Kettle & Moss' }))

  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      changes: [
        { path: 'eggox.json', kind: 'changed' },
        { path: 'rooms/Kettle - Moss/main.lua', kind: 'added' },
        { path: 'rooms/Kettle - Moss/room.json', kind: 'added' },
        { path: 'rooms/The Hearth/main.lua', kind: 'removed' },
        { path: 'rooms/The Hearth/room.json', kind: 'removed' },
        { path: 'rooms/Brew Room/game.lua', kind: 'changed' },
      ],
      rooms: [
        { name: 'Kettle & Moss', kept: 4 },
        { name: 'Brew Room', kept: 2 },
        { name: 'Garden', kept: 3, placed: 1 },
        { name: 'Shop', kept: 1 },
      ],
      warnings: [],
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const env = { ...process.env, EGGOX_TOKEN: 't', EGGOX_SERVER: `http://127.0.0.1:${server.address().port}`, EGGOX_HOME: dir }
  const { code, stdout } = await run(['check', dir], env)
  assert.equal(code, 0)
  assert.match(stdout, /renamed rooms\/The Hearth → rooms\/Kettle - Moss/)
  assert.doesNotMatch(stdout, /^[+-] rooms\/(The Hearth|Kettle - Moss)/m)
  assert.match(stdout, /~ rooms\/Brew Room\/game\.lua/)
  assert.match(stdout, /Garden: 1 placed/)
  assert.match(stdout, /^1 room unchanged\.$/m)
})
