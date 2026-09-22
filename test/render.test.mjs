import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
const cli = fileURLToPath(new URL("../bin/eggox.mjs", import.meta.url))
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64")
function run(args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data)
    child.on("error", reject); child.on("exit", code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eggox-render-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const requests = [], response = { status: 200, body: { image: { mime_type: "image/png", data: png.toString("base64"), width: 1, height: 1 }, quota: { remaining: 29 }, metadata: { panels: [] } } }
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null })
    res.writeHead(response.status, { "content-type": "application/json" }); res.end(JSON.stringify(response.body))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const env = { ...process.env, EGGOX_HOME: dir, EGGOX_SERVER: origin, EGGOX_TOKEN: "test-only" }
  const file = path.join(dir, "blueprint.json")
  fs.writeFileSync(file, JSON.stringify({ format: "eggox-blueprint", version: 1, display_name: "Test", item_type: "solid", size: { x: 2, y: 2, z: 2 }, palette: ["#000000", "#ff0000"], rotations: 4, frames: [{ voxels: [[0,0,0,1]] }, { voxels: [[1,1,1,1]] }] }))
  return { dir, file, requests, response, env }
}

test("local blueprint edits render remotely, save PNG plus metadata, and protect files", async t => {
  const { dir, file, requests, env } = await setup(t), output = path.join(dir, "preview.png")
  const args = ["blueprint", "render", file, "--frame", "1", "--rotation", "90", "--output", output]
  const rendered = await run(args, env)
  assert.equal(rendered.code, 0, rendered.stderr)
  assert.deepEqual(fs.readFileSync(output), png)
  assert.equal(JSON.parse(fs.readFileSync(`${output}.json`)).quota.remaining, 29)
  assert.equal(requests[0].url, "/api/dev/blueprints/render")
  assert.equal(requests[0].body.frame, 1)
  assert.equal(requests[0].body.rotation, 90)
  assert.equal(requests[0].authorization, "Bearer test-only")
  assert.ok(requests[0].body.source.voxel_source_b64)
  assert.equal((await run(args, env)).code, 1)
  assert.equal(requests.length, 1)
  assert.equal((await run([...args, "--force"], env)).code, 0)
})

test("experience crops use project identity and saved layout without pushing edits", async t => {
  const { dir, requests, env } = await setup(t)
  fs.writeFileSync(path.join(dir, "eggox.json"), JSON.stringify({ id: "room:root", name: "Root", rooms: [] }))
  const result = await run(["render", dir, "--room", "Main", "--bounds", "2,3,4,5", "--state", "published", "--output", path.join(dir, "room.png")], env)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(requests[0].url, "/api/dev/games/root/render")
  assert.deepEqual(requests[0].body.bounds, [2,3,4,5])
  assert.deepEqual(requests[0].body.rooms, ["Main"])
  assert.equal(requests[0].body.state, "published")
  assert.equal(requests.length, 1)
})

test("MCP returns native image content, not an opaque base64 text dump", async t => {
  const { file, env } = await setup(t)
  const input = [
    { id: 1, jsonrpc: "2.0", method: "tools/list" },
    { id: 2, jsonrpc: "2.0", method: "tools/call", params: { name: "eggox_blueprint_render", arguments: { file, frame: 1 } } },
  ].map(JSON.stringify).join("\n") + "\n"
  const result = await run(["mcp"], env, input)
  assert.equal(result.code, 0, result.stderr)
  const [list, rendered] = result.stdout.trim().split("\n").map(JSON.parse)
  for (const name of ["eggox_render", "eggox_blueprint_render", "eggox_render_quota"]) assert.ok(list.result.tools.some(tool => tool.name === name))
  assert.equal(rendered.result.content[0].type, "image")
  assert.equal(rendered.result.content[0].mimeType, "image/png")
  assert.equal(rendered.result.content[0].data, png.toString("base64"))
  assert.equal(JSON.parse(rendered.result.content[1].text).file, undefined)
})

test("hourly quota errors preserve reset information and do not write files", async t => {
  const { dir, response, env } = await setup(t)
  response.status = 429; response.body = { error: "render_quota", retry_after: 120, quota: { resets_at: "2026-09-22T12:00:00Z" } }
  const output = path.join(dir, "saved.png")
  const result = await run(["blueprint", "render", "--id", "bp_saved", "--output", output], env)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /hourly render allowance exhausted/)
  assert.match(result.stderr, /2026-09-22T12:00:00Z/)
  assert.equal(fs.existsSync(output), false)
})

test("invalid options fail before a render request", async t => {
  const { dir, file, env, requests } = await setup(t)
  for (const flags of [["--frame", "5"], ["--width", "99999"], ["--rotation", "30"], ["--background", "oops"]]) {
    const result = await run(["blueprint", "render", file, "--output", path.join(dir, "bad.png"), ...flags], env)
    assert.equal(result.code, 1, result.stderr)
  }
  assert.equal(requests.length, 0)
})
