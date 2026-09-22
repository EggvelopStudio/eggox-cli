#!/usr/bin/env node
// The eggox command line: a creator's games as files on their own
// machine. Log in once, pull a game, work on the files with any editor
// or agent, check, push, publish. `eggox mcp` serves the same commands
// to an AI agent over stdio. No dependencies beyond node 18.
//
// The project's shape is documented at <server>/developers/project.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import crypto from "node:crypto"
import readline from "node:readline"
import { spawn } from "node:child_process"

const VERSION = "0.1.4"
const DEFAULT_SERVER = "https://eggox.net"
const CONFIG_DIR = path.join(process.env.EGGOX_HOME || path.join(os.homedir(), ".config"), "eggox")
const CREDENTIALS = path.join(CONFIG_DIR, "credentials.json")

const HELP = `eggox ${VERSION}: your Eggox games as files, from your own machine.

  eggox login [--server URL]     log in (a browser opens once)
  eggox logout                   forget the login
  eggox whoami                   who is logged in, on which server
  eggox games                    the games you own
  eggox pull <game> [dir]        the game as files (by name or id)
  eggox check [dir]              would these files work? errors as file:line
  eggox push [dir] [--force]     make the game match the files
  eggox publish [dir]            publish the game as it stands
  eggox bag                      the mints in your bag
  eggox stock [dir]              the things this game holds
  eggox stock add <mint> [dir]   a mint from the bag into the game's stock
  eggox stock take <thing> [dir] a thing back to the bag (none may stand)
  eggox docs [api|project]       the reference, as markdown
  eggox mcp                      serve these to an AI agent (MCP over stdio)
  eggox update                   fetch the newest eggox from the server

  --server URL   which Eggox (default: the one you logged in to last)
  --json         machine-readable output
  EGGOX_TOKEN    a token to use instead of logging in
`

// ── Arguments ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {}
  const args = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--server") flags.server = argv[++i]
    else if (a.startsWith("--server=")) flags.server = a.slice(9)
    else if (a === "--json") flags.json = true
    else if (a === "--force") flags.force = true
    else if (a === "--help" || a === "-h") flags.help = true
    else args.push(a)
  }
  return { flags, args }
}

class Fail extends Error {}

// ── Credentials ───────────────────────────────────────────────────

function readCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS, "utf8"))
  } catch {
    return { default: null, servers: {} }
  }
}

function writeCredentials(creds) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(CREDENTIALS, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 })
}

// The installer (curl .../cli/install.sh | sh) from a server other than
// eggox.net leaves a server.json beside this file, so an install from
// staging talks to staging without --server.
function installedServer() {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), "server.json"), "utf8")).default || null
  } catch {
    return null
  }
}

function serverFor(flags, dir) {
  const state = dir ? readState(dir) : null
  return normalizeServer(flags.server || process.env.EGGOX_SERVER || state?.server || readCredentials().default || installedServer() || DEFAULT_SERVER)
}

function normalizeServer(url) {
  return url.replace(/\/+$/, "")
}

// ── The API ───────────────────────────────────────────────────────

async function token(server) {
  if (process.env.EGGOX_TOKEN) return process.env.EGGOX_TOKEN
  const creds = readCredentials()
  const entry = creds.servers?.[server]
  if (!entry) throw new Fail(`not logged in to ${server}: run eggox login${server === DEFAULT_SERVER ? "" : ` --server ${server}`}`)
  if (entry.expires_at && Date.parse(entry.expires_at) - Date.now() < 60_000) return refresh(server, creds, entry)
  return entry.access_token
}

async function refresh(server, creds, entry) {
  const res = await fetch(`${server}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: entry.refresh_token, client_id: entry.client_id }),
  })
  if (!res.ok) throw new Fail(`the login to ${server} has expired: run eggox login`)
  const t = await res.json()
  creds.servers[server] = { ...entry, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() }
  writeCredentials(creds)
  return t.access_token
}

async function api(server, method, route, body) {
  const t = await token(server)
  const res = await fetch(`${server}/api/dev${route}`, {
    method,
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  const text = await res.text()
  try {
    data = JSON.parse(text)
  } catch {
    data = { error: `the server answered ${res.status} without JSON`, text: text.slice(0, 200) }
  }
  return { status: res.status, data }
}

function refuse(reply, what) {
  const d = reply.data
  if (reply.status === 401) throw new Fail(d.text || "not logged in: run eggox login")
  if (reply.status === 429) throw new Fail("slow down: too many requests this minute")
  if (d.errors) throw new Fail(`${what} refused:\n` + d.errors.map(formatError).join("\n"))
  throw new Fail(`${what} refused: ${d.text || d.error || reply.status}`)
}

function formatError(e) {
  return `${e.file}${e.line ? ":" + e.line : ""}: ${e.text}`
}

// ── The project on disk ───────────────────────────────────────────

const PROJECT_FILE = /^(eggox\.json|rooms\/[^/]+\/(room\.json|[^/]+\.lua)|things\/[^/]+\.(lua|json))$/

function readProject(dir) {
  const files = {}
  const walk = (rel) => {
    const abs = path.join(dir, rel)
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(relPath)
      else if (PROJECT_FILE.test(relPath)) files[relPath] = fs.readFileSync(path.join(dir, relPath), "utf8")
    }
  }
  if (!fs.existsSync(path.join(dir, "eggox.json"))) throw new Fail(`no eggox.json in ${dir}: pull a game first (eggox pull <game>)`)
  walk("")
  return files
}

function writeProject(dir, files) {
  // What was a project file and is not in the game any more goes.
  if (fs.existsSync(path.join(dir, "eggox.json"))) {
    for (const rel of Object.keys(readProject(dir))) if (!(rel in files)) fs.rmSync(path.join(dir, rel))
    for (const sub of ["rooms", "things"]) pruneEmpty(path.join(dir, sub))
  }
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  const ignore = path.join(dir, ".gitignore")
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, ".eggox/\n")
}

function pruneEmpty(abs) {
  if (!fs.existsSync(abs)) return
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) if (entry.isDirectory()) pruneEmpty(path.join(abs, entry.name))
  if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs)
}

function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ".eggox", "state.json"), "utf8"))
  } catch {
    return null
  }
}

function writeState(dir, state) {
  fs.mkdirSync(path.join(dir, ".eggox"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".eggox", "state.json"), JSON.stringify(state, null, 2) + "\n")
}

function gameOf(dir) {
  let game
  try {
    game = JSON.parse(fs.readFileSync(path.join(dir, "eggox.json"), "utf8"))
  } catch {
    throw new Fail(`no readable eggox.json in ${dir}: pull a game first (eggox pull <game>)`)
  }
  const id = readState(dir)?.game || game.id
  if (!id) throw new Fail(`eggox.json in ${dir} names no game id`)
  return { id, name: game.name }
}

// A room id is "room:" + the portal's; the colon cannot travel in a URL
// path, so the API takes the id without it.
function ref(id) {
  return id.replace(/^room:/, "")
}

function slug(name) {
  return (name || "game").replace(/[^A-Za-z0-9 _-]+/gu, "-").trim().replace(/^-+|-+$/g, "").slice(0, 40) || "game"
}

// ── Commands ──────────────────────────────────────────────────────

async function update(flags) {
  // Installed by npm: npm owns the file.
  // (npm links bin/eggox to the package, so look through the link.)
  if (fs.realpathSync(process.argv[1]).includes("node_modules")) {
    throw new Fail(`this eggox came from npm; update it with:\n  npm install -g @eggox/cli@latest`)
  }
  const server = serverFor(flags)
  const res = await fetch(`${server}/cli/eggox.mjs`)
  const text = res.ok ? await res.text() : ""
  const version = /const VERSION = "([^"]+)"/.exec(text)?.[1]
  // Anything that is not the CLI (a website, an error page) is not written.
  if (!version || !text.startsWith("#!/usr/bin/env node")) throw new Fail(`${server} does not hand out the CLI (${res.status}); nothing changed`)
  if (version === VERSION) return console.log(`eggox ${VERSION} is current.`)
  fs.writeFileSync(process.argv[1], text)
  console.log(`eggox ${VERSION} → ${version}, from ${server}.`)
}

async function login(flags) {
  const server = normalizeServer(flags.server || process.env.EGGOX_SERVER || installedServer() || DEFAULT_SERVER)
  const port = 20000 + Math.floor(Math.random() * 20000)
  const redirect = `http://127.0.0.1:${port}/callback`
  const reg = await fetch(`${server}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "eggox-cli" }),
  })
  if (!reg.ok) throw new Fail(`${server} did not accept the login request (${reg.status})`)
  const { client_id } = await reg.json()
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest())
  const state = b64url(crypto.randomBytes(12))
  const url =
    `${server}/oauth/authorize?` +
    new URLSearchParams({ client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "games", state })

  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, redirect)
      if (u.pathname !== "/callback") return res.writeHead(404).end()
      const err = u.searchParams.get("error")
      const ok = !err && u.searchParams.get("state") === state && u.searchParams.get("code")
      // The page itself lives on the server, styled like the rest.
      res.writeHead(302, { location: `${server}/cli/done?${ok ? "ok=1" : "error=" + encodeURIComponent(err || "bad_state")}` })
      res.end()
      srv.close()
      if (ok) resolve(u.searchParams.get("code"))
      else reject(new Fail(`login was refused: ${err || "bad state"}`))
    })
    srv.listen(port, "127.0.0.1", () => {
      console.log(`Opening ${server} to let eggox in. If no browser opens, visit:\n\n  ${url}\n`)
      openBrowser(url)
    })
    setTimeout(() => {
      srv.close()
      reject(new Fail("login timed out after 5 minutes"))
    }, 5 * 60_000).unref()
  })

  const tok = await fetch(`${server}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: redirect, code_verifier: verifier }),
  })
  if (!tok.ok) throw new Fail(`the token exchange failed (${tok.status})`)
  const t = await tok.json()
  const creds = readCredentials()
  creds.default = server
  creds.servers = creds.servers || {}
  creds.servers[server] = { client_id, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() }
  writeCredentials(creds)
  const me = await api(server, "GET", "/me")
  console.log(`Logged in to ${server} as ${me.data.name || me.data.id}.`)
}

function logout(flags) {
  const creds = readCredentials()
  const server = normalizeServer(flags.server || creds.default || DEFAULT_SERVER)
  delete creds.servers?.[server]
  if (creds.default === server) creds.default = Object.keys(creds.servers || {})[0] || null
  writeCredentials(creds)
  console.log(`Logged out of ${server}.`)
}

async function whoami(flags) {
  const server = serverFor(flags)
  const me = await api(server, "GET", "/me")
  if (me.status !== 200) refuse(me, "whoami")
  if (flags.json) return print({ server, ...me.data })
  console.log(`${me.data.name || me.data.id} on ${server}`)
}

async function games(flags) {
  const server = serverFor(flags)
  const r = await api(server, "GET", "/games")
  if (r.status !== 200) refuse(r, "games")
  if (flags.json) return print(r.data)
  if (r.data.games.length === 0) return console.log("You own no games yet. Buy an experience in the Shop and place its door.")
  for (const g of r.data.games) console.log(`${g.name}\n  ${g.id}  ${g.rooms} room${g.rooms === 1 ? "" : "s"}  api v${g.api}  ${g.published ? "published" : "not published yet"}`)
}

async function resolveGame(server, ref) {
  if (ref.startsWith("room:")) return { id: ref, name: ref }
  const r = await api(server, "GET", "/games")
  if (r.status !== 200) refuse(r, "games")
  const hits = r.data.games.filter((g) => g.name === ref || slug(g.name) === ref || g.id === ref)
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) throw new Fail(`no game of yours called ${JSON.stringify(ref)}; eggox games lists them`)
  throw new Fail(`several games are called ${JSON.stringify(ref)}; use the id`)
}

async function pull(flags, args) {
  if (!args[0]) throw new Fail("which game? eggox pull <name or id> [dir]")
  const server = serverFor(flags)
  const game = await resolveGame(server, args[0])
  const dir = path.resolve(args[1] || slug(game.name))
  const r = await api(server, "GET", `/games/${ref(game.id)}`)
  if (r.status !== 200) refuse(r, "pull")
  writeProject(dir, r.data.files)
  writeState(dir, { server, game: game.id, revision: r.data.revision, pulled_at: new Date().toISOString() })
  for (const w of r.data.warnings || []) console.log(`note: ${w}`)
  if (flags.json) return print({ dir, files: Object.keys(r.data.files).length, revision: r.data.revision })
  console.log(`Pulled ${game.name} into ${path.relative(process.cwd(), dir) || "."} (${Object.keys(r.data.files).length} files, revision ${r.data.revision}).`)
}

async function check(flags, args) {
  const dir = path.resolve(args[0] || ".")
  const server = serverFor(flags, dir)
  const game = gameOf(dir)
  const r = await api(server, "POST", `/games/${ref(game.id)}/check`, { files: readProject(dir) })
  if (flags.json) return print(r.data)
  if (r.status !== 200) refuse(r, "check")
  report(r.data, "would be")
}

async function push(flags, args) {
  const dir = path.resolve(args[0] || ".")
  const server = serverFor(flags, dir)
  const game = gameOf(dir)
  const state = readState(dir)
  const r = await api(server, "PUT", `/games/${ref(game.id)}`, { files: readProject(dir), revision: state?.revision || null, force: !!flags.force })
  if (flags.json) return print(r.data)
  if (r.status === 409) throw new Fail(`${r.data.text}\n  eggox pull ${game.id} ${dir}   or   eggox push --force`)
  if (r.status !== 200) refuse(r, "push")
  writeState(dir, { ...(state || {}), server, game: game.id, revision: r.data.revision, pushed_at: new Date().toISOString() })
  report(r.data, "is")
  console.log(`Pushed. The game is the draft now; open it in Eggox to play it, or eggox publish.`)
}

// What a push (or a check) did, as the creator thinks of it: the files
// that differ, then the rooms where things moved. Rooms nothing
// happened in are one line together.
function report(data, verb) {
  const { renames, rest: changes } = renamedRooms(data.changes || [])
  for (const [from, to] of renames) console.log(`renamed rooms/${from} → rooms/${to}`)
  for (const c of changes) console.log(`${c.kind === "added" ? "+" : c.kind === "removed" ? "-" : "~"} ${c.path}`)
  if (renames.length) console.log("note: folder names are the room names with characters like & / : turned into -; send() and doors take the real room name")
  const rooms = data.rooms || []
  const touched = new Set((data.changes || []).map((c) => c.path.split("/")[1]).filter(Boolean))
  const moved = rooms.filter((r) => r.created || r.placed || r.removed)
  for (const room of moved) {
    const parts = []
    if (room.created) parts.push("new room")
    if (room.placed) parts.push(`${room.placed} placed`)
    if (room.removed) parts.push(`${room.removed} picked up`)
    console.log(`${room.name}: ${parts.join(", ")}`)
  }
  // A room is untouched when nothing was placed or picked up in it and
  // none of its files changed.
  const still = rooms.filter((r) => !moved.includes(r) && !touched.has(slug(r.name))).length
  const things = rooms.reduce((n, r) => n + (r.kept || 0), 0)
  if (changes.length === 0 && renames.length === 0 && moved.length === 0) console.log(`Nothing ${verb === "would be" ? "would change" : "changed"}: ${rooms.length} room${rooms.length === 1 ? "" : "s"}, ${things} things as they were.`)
  else if (still > 0) console.log(`${still} room${still === 1 ? "" : "s"} unchanged.`)
  for (const w of data.warnings || []) console.log(`note: ${w}`)
  if (verb === "would be") console.log("Everything compiles. Nothing was written.")
}

// A room folder whose every file went away while another came with the
// same files is one room renamed, not a room removed and one added.
function renamedRooms(changes) {
  const byFolder = (kind) => {
    const m = new Map()
    for (const c of changes) {
      const [top, folder, ...file] = c.path.split("/")
      if (top !== "rooms" || c.kind !== kind || !folder) continue
      if (!m.has(folder)) m.set(folder, [])
      m.get(folder).push(file.join("/"))
    }
    return m
  }
  const gone = byFolder("removed")
  const came = byFolder("added")
  const renames = []
  for (const [from, files] of gone) {
    const key = [...files].sort().join("\n")
    for (const [to, others] of came) {
      if ([...others].sort().join("\n") !== key || renames.some(([, t]) => t === to)) continue
      renames.push([from, to])
      break
    }
  }
  const renamed = new Set(renames.flat())
  const rest = changes.filter((c) => !(c.path.startsWith("rooms/") && c.kind !== "changed" && renamed.has(c.path.split("/")[1])))
  return { renames, rest }
}

async function publish(flags, args) {
  const dir = path.resolve(args[0] || ".")
  const server = serverFor(flags, dir)
  const game = gameOf(dir)
  const r = await api(server, "POST", `/games/${ref(game.id)}/publish`)
  if (flags.json) return print(r.data)
  if (r.status !== 200) refuse(r, "publish")
  console.log(`Published ${r.data.room.name}: version ${r.data.room.version}. Copies behind its door run this from now on.`)
}

async function bag(flags) {
  const server = serverFor(flags)
  const r = await api(server, "GET", "/bag")
  if (r.status !== 200) refuse(r, "bag")
  if (flags.json) return print(r.data)
  if (r.data.mints.length === 0) return console.log("No mints in your bag.")
  for (const m of r.data.mints) console.log(`${m.name}${m.quantity > 1 ? ` ×${m.quantity}` : ""}\n  ${m.id}`)
}

async function stock(flags, args) {
  const sub = ["add", "take"].includes(args[0]) ? args.shift() : "list"
  const what = sub === "list" ? null : args.shift()
  const dir = path.resolve(args[0] || ".")
  const server = serverFor(flags, dir)
  const game = gameOf(dir)
  if (sub === "list") {
    const r = await api(server, "GET", `/games/${ref(game.id)}/stock`)
    if (r.status !== 200) refuse(r, "stock")
    if (flags.json) return print(r.data)
    if (r.data.stock.length === 0) return console.log("The game holds nothing yet. eggox stock add <mint> puts one in from the bag.")
    for (const s of r.data.stock) console.log(`${s.thing}  (${s.instances} standing${s.rooms.length ? ": " + s.rooms.map((x) => `${x.count} in ${x.name}`).join(", ") : ""})`)
    return
  }
  if (!what) throw new Fail(`which one? eggox stock ${sub} <name or id>`)
  const r = sub === "add" ? await api(server, "POST", `/games/${ref(game.id)}/stock`, { item: what }) : await api(server, "DELETE", `/games/${ref(game.id)}/stock/${what}`)
  if (flags.json) return print(r.data)
  if (r.status !== 200) throw new Fail(`stock ${sub} refused: ${r.data.error || r.status}`)
  console.log(sub === "add" ? `In the game's stock now. Name it in a room's things as ${JSON.stringify(slug(what))} (eggox stock lists the exact name).` : "Back in your bag.")
}

async function docs(flags, args) {
  const server = serverFor(flags)
  const which = args[0] === "project" ? "project" : args[0] === "cli" ? "project" : "v1"
  const res = await fetch(`${server}/developers/${which}.md`)
  if (!res.ok) throw new Fail(`${server} has no ${which} page (${res.status})`)
  process.stdout.write(await res.text())
}

// ── MCP over stdio ────────────────────────────────────────────────

const TOOLS = [
  { name: "eggox_games", description: "The games the logged-in creator owns: id, name, rooms, published or not.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "eggox_pull", description: "Pull a game (by name or id) as files into a folder. Returns the folder and the file list.", inputSchema: { type: "object", properties: { game: { type: "string" }, dir: { type: "string", description: "folder to write into (default: the game's name)" } }, required: ["game"], additionalProperties: false } },
  { name: "eggox_check", description: "Would the project in a folder work? Returns what would change, or errors as file:line: text.", inputSchema: { type: "object", properties: { dir: { type: "string" } }, additionalProperties: false } },
  { name: "eggox_push", description: "Make the game match the project in a folder (its draft; the human plays it in Eggox). Refused if the game changed since the pull unless force.", inputSchema: { type: "object", properties: { dir: { type: "string" }, force: { type: "boolean" } }, additionalProperties: false } },
  { name: "eggox_bag", description: "The mints in the creator's bag (things a game can hold).", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "eggox_stock", description: "The things a game holds, with how many stand where.", inputSchema: { type: "object", properties: { dir: { type: "string" } }, additionalProperties: false } },
  { name: "eggox_stock_add", description: "Put a mint from the bag into the game's stock, so rooms can place it by name.", inputSchema: { type: "object", properties: { item: { type: "string", description: "the mint's name or id" }, dir: { type: "string" } }, required: ["item"], additionalProperties: false } },
  { name: "eggox_docs", description: "The reference as markdown: 'api' (the scripting API: events, verbs, bricks) or 'project' (the file format and the CLI). Read both before writing a game.", inputSchema: { type: "object", properties: { page: { type: "string", enum: ["api", "project"] } }, required: ["page"], additionalProperties: false } },
]

async function mcp(flags) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
  const capture = async (fn) => {
    const lines = []
    const orig = console.log
    console.log = (...a) => lines.push(a.join(" "))
    try {
      await fn()
      return lines.join("\n")
    } finally {
      console.log = orig
    }
  }
  for await (const line of rl) {
    if (!line.trim()) continue
    let req
    try {
      req = JSON.parse(line)
    } catch {
      continue
    }
    const { id, method, params = {} } = req
    const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result })
    try {
      if (method === "initialize") reply({ protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "eggox", version: VERSION } })
      else if (method === "notifications/initialized" || method === "notifications/cancelled") continue
      else if (method === "ping") reply({})
      else if (method === "tools/list") reply({ tools: TOOLS })
      else if (method === "tools/call") {
        const a = params.arguments || {}
        const f = { ...flags, json: false, force: !!a.force }
        let text
        try {
          text = await capture(async () => {
            switch (params.name) {
              case "eggox_games": return games(f)
              case "eggox_pull": return pull(f, [a.game, a.dir].filter(Boolean))
              case "eggox_check": return check(f, [a.dir || "."])
              case "eggox_push": return push(f, [a.dir || "."])
              case "eggox_bag": return bag(f)
              case "eggox_stock": return stock(f, [a.dir || "."])
              case "eggox_stock_add": return stock(f, ["add", a.item, a.dir || "."])
              case "eggox_docs": {
                const server = serverFor(f)
                const res = await fetch(`${server}/developers/${a.page === "project" ? "project" : "v1"}.md`)
                console.log(await res.text())
                return
              }
              default: throw new Fail(`no tool called ${params.name}`)
            }
          })
          reply({ content: [{ type: "text", text: text || "done" }] })
        } catch (e) {
          reply({ content: [{ type: "text", text: e.message }], isError: true })
        }
      } else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${method}` } })
    } catch (e) {
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } })
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref()
  } catch {}
}

function print(x) {
  console.log(JSON.stringify(x, null, 2))
}

// ── Main ──────────────────────────────────────────────────────────

const { flags, args } = parseArgs(process.argv.slice(2))
const command = args.shift()
const run = {
  login: () => login(flags),
  logout: () => logout(flags),
  whoami: () => whoami(flags),
  games: () => games(flags),
  pull: () => pull(flags, args),
  check: () => check(flags, args),
  push: () => push(flags, args),
  publish: () => publish(flags, args),
  bag: () => bag(flags),
  stock: () => stock(flags, args),
  docs: () => docs(flags, args),
  mcp: () => mcp(flags),
  update: () => update(flags),
}[command]

if (!command || flags.help || !run) {
  process.stdout.write(HELP)
  process.exit(command && !run ? 1 : 0)
}

// Every command goes through one promise, whether it is async or not.
Promise.resolve()
  .then(run)
  .catch((e) => {
    if (e instanceof Fail) {
      console.error(e.message)
      process.exit(1)
    }
    console.error(e?.stack || String(e))
    process.exit(2)
  })
