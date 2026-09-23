import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import http from "node:http"
import { fileURLToPath } from "node:url"
import { encodeBlueprint, decodeBlueprint, BLUEPRINT_RULES, BLUEPRINT_SCHEMA } from "../bin/eggox.mjs"
const cli = fileURLToPath(new URL("../bin/eggox.mjs", import.meta.url))
const fixture = () => ({ format: "eggox-blueprint", version: 1, display_name: "Block", item_type: "solid", size: { x: 2, y: 2, z: 2 }, palette: ["#000000", "#ff0000", "#00ff00"], rotations: 4, frames: [{ voxels: [[0, 0, 0, 1], [1, 1, 1, 2]] }] })
function run(args, options = {}) { return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", ...options }) }
async function asyncRun(args, options) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, ...args], options)
    let stdout = "", stderr = ""
    p.stdout.on("data", d => stdout += d); p.stderr.on("data", d => stderr += d)
    p.on("error", reject); p.on("exit", code => resolve({ stdout, stderr, code }))
  })
}

test("full frame codec retains coordinates, palette, layers and metadata", () => {
  const doc = fixture()
  doc.frames.push({ layers: [
    { name: "body", visible: true, voxels: [[1, 0, 0, 1]] },
    { name: "hat", visible: true, voxels: [[1, 0, 0, 2]] },
    { name: "hidden", visible: false, voxels: [[0, 1, 1, 1]] },
  ], activeLayer: 2 })
  doc.behavior = { clips: [{ name: "blink", frames: [0, 1, 0] }], states: [{ name: "idle", clip: "blink" }], interactions: [] }
  doc.zones = { zones: [] }; doc.skeleton = { bones: [] }
  doc.voxel_binding_b64 = Buffer.alloc(8).toString("base64")
  const packed = encodeBlueprint(doc), pulled = decodeBlueprint(packed)
  assert.deepEqual(pulled.frames[1], { ...doc.frames[1], duration_ms: 100 })
  assert.deepEqual(pulled.behavior, doc.behavior)
  assert.deepEqual(pulled.skeleton, doc.skeleton)
  assert.equal(pulled.voxel_binding_b64, doc.voxel_binding_b64)
  assert.deepEqual(encodeBlueprint(pulled), packed)
})

test("rejects invalid frames before any network call", () => {
  for (const mutate of [
    d => d.frames[0].voxels.push([2, 0, 0, 1]),
    d => d.frames[0].voxels.push([0, 0, 0, 2]),
    d => d.frames[0].voxels.push([1, 0, 0, 3]),
    d => d.frames[0].duration_ms = 200,
    d => d.size.x = 129,
    d => d.frames = [],
    d => d.frames[0].layers = [],
    d => d.surfaceIndices = [0],
    d => d.frames[0].activeLayer = 1,
    d => d.behavior = { clips: [{ name: "nope", frames: [1] }] },
    d => d.behavior = { states: [{ name: "idle", clip: "missing" }] },
    d => d.behavior = { frameGround: [3] },
    d => d.size = { x: 128, y: 128, z: 128 },
  ]) {
    const d = fixture(); mutate(d)
    if (d.size.x === 128) d.frames = Array.from({ length: 33 }, () => ({ voxels: [] }))
    assert.throws(() => encodeBlueprint(d))
  }
})

test("character animation ownership, order, commands and object footprint rules", () => {
  const doc = fixture(); doc.item_type = "character"
  doc.frames = Array.from({ length: 3 }, () => ({ voxels: [] }))
  doc.behavior = { clips: [{ name: "walk", frames: [0] }, { name: "wave", frames: [1, 2], order: [0, 0, 1], command: "wave", repeat: 2 }] }
  assert.doesNotThrow(() => encodeBlueprint(doc))
  const invalid = structuredClone(doc); invalid.behavior.clips[1].frames = [0]
  assert.throws(() => encodeBlueprint(invalid), /belong to exactly one clip/)
  doc.behavior.clips[1].command = "stop"
  assert.throws(() => encodeBlueprint(doc), /reserved/)
  const block = fixture(); block.behavior = { footprint: { sizeX: 2, sizeY: 2, cells: [2] } }
  assert.doesNotThrow(() => encodeBlueprint(block))
  block.behavior.footprint.cells = [3]
  assert.throws(() => encodeBlueprint(block), /footprint/)
})

test("refuses truncated, surface and corrupt RLE sources", () => {
  const packed = encodeBlueprint(fixture()), bytes = Buffer.from(packed.voxel_source_b64, "base64")
  for (const edited of [bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from([1])]), Buffer.from(bytes), Buffer.from(bytes)]) {
    if (edited.length === bytes.length) edited[0] = 4
    assert.throws(() => decodeBlueprint({ ...packed, voxel_source_b64: edited.toString("base64") }))
  }
  const malformed = Buffer.from(bytes); malformed[30] = 0
  assert.throws(() => decodeBlueprint({ ...packed, voxel_source_b64: malformed.toString("base64") }))
})

test("schema and local frame replacement work offline and protect files", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eggox-blueprints-")); t.after(() => fs.rmSync(dir, { recursive: true }))
  const file = path.join(dir, "block.json"), frame = path.join(dir, "frame.json")
  assert.equal(run(["blueprint", "init", file]).status, 0)
  assert.equal(run(["blueprint", "init", file]).status, 1)
  fs.writeFileSync(frame, JSON.stringify({ voxels: [[1, 1, 1, 1]] }))
  assert.equal(run(["blueprint", "frame", file, "0", frame]).status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).frames[0].voxels, [[1, 1, 1, 1]])
  const before = fs.readFileSync(file, "utf8")
  fs.writeFileSync(frame, JSON.stringify({ voxels: [[999, 0, 0, 1]] }))
  assert.equal(run(["blueprint", "frame", file, "0", frame]).status, 1)
  assert.equal(fs.readFileSync(file, "utf8"), before)
  const link = path.join(dir, "eggox.mjs")
  fs.symlinkSync(cli, link)
  assert.match(spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" }).stdout, /blueprints/)
  const schema = JSON.parse(run(["blueprint", "schema"]).stdout)
  assert.deepEqual(schema.schema, BLUEPRINT_SCHEMA); assert.deepEqual(schema.rules, BLUEPRINT_RULES)
})

test("push reads disk, authenticates, updates receipt and keeps conflict files intact", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eggox-push-")); t.after(() => fs.rmSync(dir, { recursive: true }))
  const file = path.join(dir, "block.json"), requests = []
  let conflict = false
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(conflict ? 409 : 200, { "content-type": "application/json" })
    res.end(JSON.stringify(conflict ? { error: "conflict", text: "changed" } : { item: { id: "pt_next", version: 2 }, revision: "new" }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  fs.writeFileSync(file, JSON.stringify({ ...fixture(), id: "bp_old", revision: "old", server: origin }))
  const opts = { env: { ...process.env, EGGOX_TOKEN: "test-only-token", EGGOX_SERVER: "", EGGOX_HOME: dir }, stdio: ["ignore", "pipe", "pipe"] }
  const r = await asyncRun(["blueprint", "push", file], opts)
  assert.equal(r.code, 0, r.stderr)
  assert.equal(requests[0].authorization, "Bearer test-only-token")
  assert.equal(requests[0].url, "/api/dev/blueprints/bp_old")
  assert.equal(requests[0].body.revision, "old")
  assert.equal(JSON.parse(fs.readFileSync(file)).id, "pt_next")
  const before = fs.readFileSync(file, "utf8"); conflict = true
  assert.equal((await asyncRun(["blueprint", "push", file], opts)).code, 1)
  assert.equal(fs.readFileSync(file, "utf8"), before)
  const mismatched = await asyncRun(["blueprint", "push", file, "--server", "http://127.0.0.1:1"], opts)
  assert.match(mismatched.stderr, /belongs to/)
})

test("MCP discovers file tools and keeps tool errors on JSON-RPC stdout", () => {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "eggox_blueprint_check", arguments: { file: "/nonexistent/blueprint.json" } } },
  ].map(JSON.stringify).join("\n") + "\n"
  const result = run(["mcp"], { input })
  const lines = result.stdout.trim().split("\n").map(JSON.parse)
  const names = lines[0].result.tools.map(t => t.name)
  assert.ok(names.includes("eggox_blueprint_mint")); assert.ok(names.includes("eggox_blueprint_push"))
  assert.ok(!names.includes("eggox_publish"))
  assert.equal(lines[1].result.isError, true)
})

test("shared server fixture stays compatible with the shipped offline encoder", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/blueprint-source.json", import.meta.url)))
  assert.deepEqual(encodeBlueprint(fixture.document), fixture.source)
})


test("dense grids keep large pulls bounded and can be generated without sparse rows", () => {
  const doc = fixture(); doc.size = { x: 18, y: 18, z: 18 }
  doc.frames = [{ voxels_b64: Buffer.alloc(18 ** 3, 2).toString("base64") }]
  const payload = encodeBlueprint(doc), pulled = decodeBlueprint(payload)
  assert.equal(pulled.frames[0].voxels_b64, doc.frames[0].voxels_b64)
  assert.deepEqual(encodeBlueprint(pulled), payload)
  doc.frames[0].voxels_b64 = Buffer.alloc(18 ** 3 - 1).toString("base64")
  assert.throws(() => encodeBlueprint(doc), /dense grid/)
})

test("a tall solid with no footprint is warned about on check and blocks its tiles on push", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eggox-tall-"))
  try {
    const tall = { ...fixture(), size: { x: 2, y: 2, z: 40 } }
    fs.writeFileSync(path.join(dir, "tall.json"), JSON.stringify(tall))
    let r = run(["blueprint", "check", path.join(dir, "tall.json")])
    assert.equal(r.status, 0, r.stderr)
    assert.match(JSON.parse(r.stdout).warnings[0], /40 voxels tall with no footprint/)

    fs.writeFileSync(path.join(dir, "low.json"), JSON.stringify(fixture()))
    r = run(["blueprint", "check", path.join(dir, "low.json")])
    assert.equal(JSON.parse(r.stdout).warnings, undefined)

    const seat = { ...tall, item_type: "seat" }
    fs.writeFileSync(path.join(dir, "seat.json"), JSON.stringify(seat))
    r = run(["blueprint", "check", path.join(dir, "seat.json")])
    assert.equal(JSON.parse(r.stdout).warnings, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
