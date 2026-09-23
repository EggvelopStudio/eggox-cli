#!/usr/bin/env node
// The eggox command line: games and voxel blueprints as files on your own
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
import { pathToFileURL } from "node:url"

const VERSION = "0.4.2"
const DEFAULT_SERVER = "https://eggox.net"
const CONFIG_DIR = path.join(process.env.EGGOX_HOME || path.join(os.homedir(), ".config"), "eggox")
const CREDENTIALS = path.join(CONFIG_DIR, "credentials.json")

const HELP = `eggox ${VERSION}: your Eggox games and blueprints as files, from your own machine.

  eggox login [--server URL]     log in (a browser opens once)
  eggox logout                   forget the login
  eggox whoami                   who is logged in, on which server
  eggox games                    the games you own
  eggox pull <game> [dir]        the game as files (by name or id)
  eggox check [dir]              would these files work? errors as file:line
  eggox push [dir] [--force]     make the game match the files
  eggox publish [dir]            publish the game as it stands
  eggox playtest [dir]           play the pushed draft headless and print what the scripts did
  eggox logs [dir]               the last playtest's logs and errors (browser or headless)
  eggox bag                      the mints in your bag
  eggox stock [dir]              the things this game holds
  eggox stock add <mint> [dir]   a mint from the bag into the game's stock
  eggox stock take <thing> [dir] a thing back to the bag (none may stand)
  eggox stock use <thing> <version|latest> [dir]  show another published version, every instance too
  eggox entrance [dir]           current entrance and available stock mints
  eggox entrance set <mint> [dir] use a stock mint as the entrance (--room <name>: that room's door)
  eggox entrance reset [dir]     restore the default floor star
  eggox blueprints               your blueprints and latest prototypes
  eggox blueprint <action>       schema, init, pull, check, frame, render, push, history, publish, mint
  eggox blueprint render [file]  render local edits, or use --id <saved blueprint>
  eggox render [dir]             render a saved game layout (or --game <name/id>)
  eggox renders                  remaining hourly account render allowance
  eggox docs [api|project|blueprints]       the reference, as markdown
  eggox mcp                      serve these to an AI agent (MCP over stdio)
  eggox update                   fetch the newest eggox from the server

  --server URL   which Eggox (default: the one you logged in to last)
  --json         machine-readable output
  EGGOX_TOKEN    a token to use instead of logging in

Playtest options:
  --steps "click Kettle; key space; ui brew 3; wait 2; walk 4,7; close; leave"
  --script scenario.json|scenario.txt   the same steps from a file
  expect steps check the game and fail the run (exit 1) when wrong:
    expect save visits = 2 | expect game_save best = 10 | expect save k unset
    expect window shop | expect no window | expect state Kettle = boiling
    expect at 4,7 | expect room Hall | expect log brewed | expect no errors
  --room <name>  start in this room (default the root)   --reset  forget playtest saves
  --save key=value       a player save before the run (repeatable; JSON values)
  --game-save key=value  a game save before the run (repeatable)
  --saves file.json      {"player": {...}, "game": {...}} before the run
  --seed N       math.random repeats run to run
  --push         push the folder first

Render options:
  --output file.png --width 1024 --height 768 --rotation 0|90|180|270
  --view iso|top (blueprints also front; games default to each room's view)
  --background '#202632'|transparent --force (overwrite output)
  Blueprint: --frame 0 --layers 0,2 --id <saved blueprint>
  Game: --room <name/id> (repeatable) --bounds x,y,width,height
        --focus <placement-id> --margin 2 --state draft|published
        --time-ms 0 --hidden (include hidden stock)
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
    else if (a === "--remote") flags.remote = true
    else if (a === "--count") flags.count = Number(argv[++i])
    else if (["--frame", "--rotation", "--width", "--height", "--margin", "--time-ms"].includes(a)) {
      if (argv[i + 1] === undefined) throw new Fail(`${a} needs a value`)
      flags[a.slice(2).replaceAll("-", "_")] = Number(argv[++i])
    }
    else if (["--output", "--view", "--background", "--focus", "--state", "--game", "--id"].includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Fail(`${a} needs a value`)
      flags[a.slice(2)] = argv[++i]
    }
    else if (a === "--room") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Fail("--room needs a name or id")
      ;(flags.rooms ||= []).push(argv[++i])
    }
    else if (a === "--bounds" || a === "--layers") {
      if (!argv[i + 1]) throw new Fail(`${a} needs comma-separated integers`)
      flags[a.slice(2)] = argv[++i].split(",").map(v => v.trim() === "" ? NaN : Number(v))
    }
    else if (a === "--hidden") flags.hidden = true
    else if (a === "--reset") flags.reset = true
    else if (a === "--push") flags.push = true
    else if (a === "--save" || a === "--game-save") {
      const kv = argv[++i]
      const eq = kv ? kv.indexOf("=") : -1
      if (eq < 1) throw new Fail(`${a} needs key=value`)
      const scope = a === "--save" ? "player" : "game"
      ;((flags.saveValues ||= {})[scope] ||= {})[kv.slice(0, eq)] = saveValue(kv.slice(eq + 1))
    }
    else if (a === "--seed") {
      const n = Number(argv[++i])
      if (!Number.isInteger(n)) throw new Fail("--seed needs a whole number")
      flags.seed = n
    }
    else if (a === "--saves") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Fail("--saves needs a JSON file")
      flags.savesFile = argv[++i]
    }
    else if (a === "--steps" || a === "--script") {
      if (argv[i + 1] === undefined) throw new Fail(`${a} needs a value`)
      flags[a.slice(2)] = argv[++i]
    }
    else if (a === "--help" || a === "-h") flags.help = true
    else args.push(a)
  }
  return { flags, args }
}

class Fail extends Error {}

// A save's value as JSON when it reads as JSON (3, true, {"a":1}), else the text.
function saveValue(text) {
  try { return JSON.parse(text) } catch { return text }
}

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

async function api(server, method, route, body, limits) {
  const t = await token(server)
  const res = await fetch(`${server}/api/dev${route}`, {
    method,
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(limits ? { signal: AbortSignal.timeout(30_000) } : {}),
  })
  let data = null
  let text
  if (limits) {
    const chunks = []; let size = 0
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > limits.maxBytes) throw new Fail("render response exceeds the image limit")
      chunks.push(chunk)
    }
    text = Buffer.concat(chunks).toString("utf8")
  } else text = await res.text()
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
  if (reply.status === 429) throw new Fail(d.error === "render_quota"
    ? `hourly render allowance exhausted; resets at ${d.quota?.resets_at} (retry in ${d.retry_after}s)`
    : `slow down: too many requests${d.retry_after ? `; retry in ${d.retry_after}s` : " this minute"}`)
  if (d.errors) throw new Fail(`${what} refused:\n` + d.errors.map(formatError).join("\n"))
  throw new Fail(`${what} refused: ${d.text || d.error || reply.status}`)
}

function formatError(e) {
  return `${e.file}${e.line ? ":" + e.line : ""}: ${e.text}`
}

// ── The project on disk ───────────────────────────────────────────

// Any other .lua file is a shared module rooms can require("its/path").
const PROJECT_FILE = /^(eggox\.json|rooms\/[^/]+\/(room\.json|[^/]+\.lua)|things\/[^/]+\.(lua|json)|(?!rooms\/|things\/)[^/]+(\/[^/]+)*\.lua)$/

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
    new URLSearchParams({ client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "creator", state })

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

// A lineage's history lists every minted edition as its own row; the
// editions of one version are one row here, with how many there are.
function groupHistory(data) {
  const rows = data?.iterations
  if (!Array.isArray(rows)) return data
  const out = []
  const mints = new Map()
  for (const row of rows) {
    if (row.kind !== "mint") { out.push(row); continue }
    const key = row.version
    if (!mints.has(key)) {
      const group = { kind: "mint", version: row.version, display_name: row.display_name, editions: 0, quantity: 0, ids: [] }
      mints.set(key, group)
      out.push(group)
    }
    const group = mints.get(key)
    group.editions += 1
    group.quantity += row.quantity || 1
    if (group.ids.length < 10) group.ids.push(row.id)
  }
  return { ...data, iterations: out }
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

// ── Playtest ─────────────────────────────────────────────────────

// The steps of a scenario: --steps "a; b", or a file (a JSON list of
// steps, or one step per line).
function scenario(flags) {
  if (flags.script) {
    if (!fs.existsSync(flags.script)) throw new Fail(`no scenario file ${flags.script}`)
    const text = fs.readFileSync(flags.script, "utf8")
    if (flags.script.endsWith(".json")) {
      try { return JSON.parse(text) } catch { throw new Fail(`${flags.script} is not valid JSON`) }
    }
    return text
  }
  return flags.steps || ""
}

async function playtest(flags, args) {
  const dir = path.resolve(args[0] || ".")
  if (flags.push) {
    // In --json mode the push report would spoil the one JSON answer.
    const log = console.log
    if (flags.json) console.log = () => {}
    try { await push({ ...flags, json: false }, [dir]) } finally { console.log = log }
  }
  const server = serverFor(flags, dir)
  const game = gameOf(dir)
  const body = { steps: scenario(flags), room: flags.rooms?.[0] || null, reset: !!flags.reset }
  const saves = startSaves(flags)
  if (saves) body.saves = saves
  if (flags.seed !== undefined) body.seed = flags.seed
  const r = await api(server, "POST", `/games/${ref(game.id)}/playtest`, body)
  if (r.status === 200 && (r.data.errors > 0 || r.data.ok === false)) process.exitCode = 1
  if (flags.json) return print(r.data)
  if (r.status !== 200) refuse(r, "playtest")
  printPlaytest(r.data)
}

// --saves file.json, then --save / --game-save on top.
function startSaves(flags) {
  let saves = null
  if (flags.savesFile) {
    if (!fs.existsSync(flags.savesFile)) throw new Fail(`no saves file ${flags.savesFile}`)
    try { saves = JSON.parse(fs.readFileSync(flags.savesFile, "utf8")) } catch { throw new Fail(`${flags.savesFile} is not valid JSON`) }
    if (!saves || typeof saves !== "object" || Array.isArray(saves)) throw new Fail(`${flags.savesFile}: {"player": {...}, "game": {...}}`)
  }
  for (const [scope, values] of Object.entries(flags.saveValues || {})) {
    saves ||= {}
    saves[scope] = { ...(saves[scope] || {}), ...values }
  }
  return saves
}

function printPlaytest(report) {
  const failed = report.failures?.length || 0
  console.log(`Playtest of ${report.room}: ${report.seconds} s, ${report.errors} error${report.errors === 1 ? "" : "s"}${failed ? `, ${failed} expectation${failed === 1 ? "" : "s"} failed` : ""}.`)
  for (const step of report.steps) {
    const where = step.room ? `  ${step.room}${step.at ? ` ${step.at.join(",")}` : ""}` : ""
    console.log(`\n${step.step}  (+${(step.at_ms / 1000).toFixed(2)} s)${where}`)
    const floors = step.events.filter((e) => e.kind === "floor")
    for (const e of step.events) if (e.kind !== "floor") console.log(`  ${eventLine(e)}`)
    if (floors.length) console.log(`  floor: ${floors.length} tile${floors.length === 1 ? "" : "s"} painted`)
    if (step.events.length === 0 && step.step !== "end") console.log("  (nothing happened)")
  }
  const saves = report.saves || {}
  if (Object.keys(saves.player || {}).length) console.log(`\nSaved for the player: ${JSON.stringify(saves.player)}`)
  if (Object.keys(saves.game || {}).length) console.log(`Saved for the game: ${JSON.stringify(saves.game)}`)
  if (report.limits?.length) console.log(`\nLimits hit: ${report.limits.join("; ")}`)
  if (failed) {
    console.log(`\nFailed:`)
    for (const f of report.failures) console.log(`  expect ${f.expect}: ${f.got}`)
  }
}

// A window in one or two lines: id, title, text, then what can be pressed.
function windowLine(spec) {
  const head = [spec.id ? `#${spec.id}` : null, spec.title ? JSON.stringify(spec.title) : null].filter(Boolean).join(" ")
  const items = Array.isArray(spec.items) ? spec.items : []
  const texts = [spec.text, ...items.filter((i) => i.kind === "text").map((i) => i.text)].filter(Boolean)
  const text = texts.join(" / ").replace(/\s*\n\s*/g, " / ")
  const actions = items.filter((i) => i.id && i.kind !== "text").map((i) => `${i.kind === "input" ? "input " : i.kind === "card" ? "card " : ""}${i.id}${i.label && i.label !== i.id ? ` "${i.label}"` : ""}`)
  const lists = items.filter((i) => i.kind === "list").map((i) => (i.rows || []).map((r) => r.join(": ")).join(", "))
  return [head, text ? `"${text.length > 120 ? text.slice(0, 117) + "..." : text}"` : null, lists.length ? `list ${lists.join("; ")}` : null, actions.length ? `[${actions.join(", ")}]` : null].filter(Boolean).join(" ")
}

function eventLine(e) {
  const where = e.room ? `[${e.room}] ` : ""
  const thing = e.name ? `${e.name} (${e.thing || e.target})` : e.thing || e.target
  switch (e.kind) {
    case "diagnostic": return `${e.level.toUpperCase()} ${where}${e.text}`
    case "log": return `log ${where}${e.text}`
    case "entered": return `→ entered ${e.room}`
    case "window": return e.spec ? `window ${where}${windowLine(e.spec)}` : `window ${where}closed`
    case "expect": return e.ok ? `ok: expect ${e.text}` : `FAILED: expect ${e.text} (${e.got})`
    case "set_state": return `set_state ${where}${thing ?? ""} → ${e.state}`
    case "move": return `move ${where}${thing} → ${e.tile.join(",")}${e.glide_ms ? ` over ${e.glide_ms} ms` : ""}`
    case "spawn": return `spawn ${where}${thing} at ${e.tile.join(",")}`
    case "hide": case "show": return `${e.kind} ${where}${thing}`
    case "tint": return `tint ${where}${thing} ${e.color ?? "off"}`
    case "save": return `save ${where}${e.scope} ${e.key} = ${JSON.stringify(e.value)}`
    case "send": return `send ${where}→ ${e.room} (${e.players} player${e.players === 1 ? "" : "s"})`
    case "after": case "every": return `${e.kind} ${where}${e.seconds} s "${e.tag}"`
    case "effect": return `effect ${where}${JSON.stringify({ ...e, kind: undefined, room: undefined, source: undefined })}`
    default: {
      const { kind, room, source, ...rest } = e
      return `${kind} ${where}${Object.keys(rest).length ? JSON.stringify(rest) : ""}`
    }
  }
}

async function logs(flags, args) {
  const dir = path.resolve(args[0] || ".")
  const server = serverFor(flags, dir)
  const game = gameOf(dir)
  const r = await api(server, "GET", `/games/${ref(game.id)}/logs`)
  if (flags.json) return print(r.data)
  if (r.status !== 200) refuse(r, "logs")
  const run = r.data.run
  if (!run) return console.log("No playtest of this game since the server started. Playtest it in Eggox, or run eggox playtest.")
  const when = new Date(run.started_at).toISOString().replace("T", " ").slice(0, 19)
  console.log(`${run.headless ? "Headless playtest" : "Playtest"} of ${run.room}, started ${when} UTC, ${run.entries.length} line${run.entries.length === 1 ? "" : "s"}.`)
  for (const e of run.entries) {
    const t = new Date(e.at).toISOString().slice(11, 19)
    console.log(`${t} ${e.level === "log" ? "log  " : e.level.toUpperCase()} [${e.room}] ${e.message}`)
  }
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

// A room of the pulled game by its name (or folder), as its room.json says.
function roomId(dir, name) {
  const roomsDir = path.join(dir, "rooms")
  const rooms = fs.existsSync(roomsDir) ? fs.readdirSync(roomsDir) : []
  for (const folder of rooms) {
    const file = path.join(roomsDir, folder, "room.json")
    if (!fs.existsSync(file)) continue
    const room = JSON.parse(fs.readFileSync(file, "utf8"))
    if (room.name === name || folder === name || room.id === name) {
      if (!room.id) throw new Fail(`${folder} has not been pushed yet: eggox push first`)
      return room.id
    }
  }
  throw new Fail(`no room called ${JSON.stringify(name)} in ${dir}`)
}

async function entrance(flags, args) {
  const action = ["set", "reset"].includes(args[0]) ? args.shift() : "get"
  const item = action === "set" ? args.shift() : null
  if (action === "set" && !item) throw new Fail("usage: eggox entrance set <stock mint name or id> [dir]")
  const dir = path.resolve(args[0] || ".")
  const server = serverFor(flags, dir)
  // The game's own door, or with --room the door into one of its rooms.
  const target = flags.rooms?.[0] ? roomId(dir, flags.rooms[0]) : gameOf(dir).id
  const route = `/games/${ref(target)}/entrance`
  const current = await api(server, "GET", route)
  if (current.status !== 200) refuse(current, "entrance")
  if (action === "get") {
    if (flags.json) return print(current.data)
    console.log(`Entrance: ${current.data.room.entrance?.name || "default floor star"}`)
    for (const choice of current.data.items) console.log(`${choice.name}\n  ${choice.id}`)
    if (!current.data.items.length) console.log("No stock mints yet. Add one with eggox stock add <mint>.")
    return
  }
  let chosen = null
  if (action === "set") {
    const exact = current.data.items.find(row => row.id === item)
    const matches = exact ? [exact] : current.data.items.filter(row => row.name === item || row.thing === item)
    if (matches.length !== 1) throw new Fail(matches.length ? "several stock mints have that name; use an id" : "no such mint in this game's stock; add it with eggox stock add first")
    chosen = matches[0].id
  }
  const reply = await api(server, "PUT", route, { item: chosen })
  if (reply.status !== 200) refuse(reply, "entrance")
  if (flags.json) return print(reply.data)
  console.log(`Entrance updated: ${reply.data.room.entrance?.name || "default floor star"}. Applies immediately; the game draft is unchanged.`)
}

async function stock(flags, args) {
  const sub = ["add", "take", "use"].includes(args[0]) ? args.shift() : "list"
  const what = sub === "list" ? null : args.shift()
  const version = sub === "use" ? args.shift() : null
  const dir = path.resolve(args[0] || ".")
  const server = serverFor(flags, dir)
  const game = gameOf(dir)
  if (sub === "list") {
    const r = await api(server, "GET", `/games/${ref(game.id)}/stock`)
    if (r.status !== 200) refuse(r, "stock")
    if (flags.json) return print(r.data)
    if (r.data.stock.length === 0) return console.log("The game holds nothing yet. eggox stock add <mint> puts one in from the bag.")
    for (const s of r.data.stock) {
      const versions = s.versions?.length > 1 ? `, v${s.version} of ${s.versions.slice().sort((a, b) => a - b).join("/")}` : ""
      console.log(`${s.thing}  (${s.instances} standing${s.rooms.length ? ": " + s.rooms.map((x) => `${x.count} in ${x.name}`).join(", ") : ""}${versions}${s.entrances?.length ? "; entrance for " + s.entrances.map(x => x.name).join(", ") : ""})`)
    }
    return
  }
  if (!what) throw new Fail(`which one? eggox stock ${sub} <name or id>${sub === "use" ? " <version|latest>" : ""}`)
  let r
  if (sub === "add") r = await api(server, "POST", `/games/${ref(game.id)}/stock`, { item: what })
  else if (sub === "take") r = await api(server, "DELETE", `/games/${ref(game.id)}/stock/${encodeURIComponent(what)}`)
  else {
    const v = version === "latest" ? "latest" : Number(version)
    if (v !== "latest" && !Number.isInteger(v)) throw new Fail("usage: eggox stock use <thing> <version|latest> [dir]")
    r = await api(server, "POST", `/games/${ref(game.id)}/stock/${encodeURIComponent(what)}/version`, { version: v })
  }
  if (flags.json) return print(r.data)
  if (r.status !== 200) refuse(r, `stock ${sub}`)
  if (sub === "add") console.log(`In the game's stock now. Name it in a room's things as ${JSON.stringify(slug(what))} (eggox stock lists the exact name).`)
  else if (sub === "take") console.log("Back in your bag.")
  else console.log(`${r.data.thing} shows v${r.data.version} now, with the ${r.data.instances} standing.`)
}

async function docs(flags, args) {
  const server = serverFor(flags)
  const which = args[0] === "blueprints" ? "blueprints" : args[0] === "project" ? "project" : args[0] === "cli" ? "project" : "v1"
  const res = await fetch(`${server}/developers/${which}.md`)
  if (!res.ok) throw new Fail(`${server} has no ${which} page (${res.status})`)
  process.stdout.write(await res.text())
}

// ── Blueprint authoring contract (offline, no dependencies) ────────
// Mirrors schema 3 in client/src/voxel/format.ts and server Authoring.
export const BLUEPRINT_RULES = {
  format: "eggox-blueprint", version: 1, source_schema: 3,
  voxels_per_tile: 32, max_side: 128, max_frames: 500, frame_tick_ms: 100,
  world_cycle_frames: 16, max_palette: 256, transparent_index: 0,
  max_layers: 12, max_layer_name: 24, max_source_bytes: 6_000_000,
  max_decoded_bytes: 67_108_864, max_metadata_bytes: 200_000, max_http_bytes: 10_000_000,
  offset: "x + y * size.x + z * size.x * size.y",
  axes: { x: "down-right", y: "down-left", z: "up" },
  frame: "Complete snapshot, never a delta. Supply voxels OR layers. Use sparse [x,y,z,paletteIndex] rows or dense voxels_b64 bytes; absent sparse cells are empty. Layers are bottom first; the last visible nonzero voxel wins.",
  item_types: ["solid", "seat", "bed", "water", "wearable_head", "wearable_body", "wearable_legs", "wearable_hand", "character"],
  animation: { max_clips: 12, max_states: 12, max_interactions: 12, max_name: 24,
    max_sequence: 64, movement_sequence: 16, movement_owned_frames: 8,
    command_owned_frames: 32, max_repeat: 20, max_ground: 64,
    reserved_commands: ["stand", "stop", "reveal", "walk", "idle"] },
}

const rowSchema = { type: "array", minItems: 4, maxItems: 4, items: { type: "integer", minimum: 0, maximum: 255 } }
const voxelsSchema = { type: "array", items: rowSchema }
const denseSchema = { type: "string", contentEncoding: "base64", description: "Exactly size.x*size.y*size.z palette-index bytes, x-fast; alternative to sparse voxels." }
const gridChoice = { oneOf: [{ required: ["voxels"], not: { required: ["voxels_b64"] } }, { required: ["voxels_b64"], not: { required: ["voxels"] } }] }
const frameSchema = { type: "object", additionalProperties: false,
  properties: { duration_ms: { const: 100 }, voxels: voxelsSchema, voxels_b64: denseSchema,
    activeLayer: { type: "integer", minimum: 0, maximum: 11 },
    layers: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false,
      properties: { name: { type: "string", maxLength: 24 }, visible: { type: "boolean" }, voxels: voxelsSchema, voxels_b64: denseSchema }, required: ["name", "visible"], ...gridChoice } } },
  oneOf: [{ ...gridChoice, not: { required: ["layers"] } }, { required: ["layers"], not: { anyOf: [{ required: ["voxels"] }, { required: ["voxels_b64"] }] } }] }
const clipSchema = { type: "object", additionalProperties: false, required: ["name", "frames"], properties: {
  name: { type: "string", minLength: 1, maxLength: 24 }, frames: { type: "array", minItems: 1, maxItems: 64, items: { type: "integer", minimum: 0, maximum: 499 } },
  order: { type: ["array", "null"], minItems: 1, maxItems: 64, items: { type: "integer", minimum: 0, maximum: 31 } },
  loop: { type: "boolean" }, whileMoving: { type: "boolean" }, repeat: { type: ["integer", "null"], minimum: 1, maximum: 20 },
  command: { type: ["string", "null"], pattern: "^[a-z0-9_-]{1,24}$" }, region: { type: ["string", "null"], minLength: 1, maxLength: 24 },
} }
const nameSchema = { type: "string", minLength: 1, maxLength: 24 }
const behaviorSchema = { type: ["object", "null"], additionalProperties: false,
  description: "Cross-reference, ownership and per-item limits are enforced by blueprint check; see rules.animation.",
  properties: {
    clips: { type: "array", maxItems: 12, items: clipSchema },
    states: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["name", "clip"], properties: { name: nameSchema, clip: nameSchema, onEnd: { ...nameSchema, type: ["string", "null"] } } } },
    interactions: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["trigger", "action"], properties: {
      trigger: { enum: ["walk_on", "walk_off", "click_in_range"] }, action: { oneOf: [
        { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "cycle" } } },
        { type: "object", additionalProperties: false, required: ["kind", "state"], properties: { kind: { const: "goto" }, state: nameSchema } },
      ] },
    } } },
    frameGround: { type: ["array", "null"], maxItems: 500, items: { type: "integer", minimum: 0, maximum: 64 } },
    footprint: { type: ["object", "null"], additionalProperties: false, required: ["sizeX", "sizeY", "cells"], properties: {
      sizeX: { type: "integer", minimum: 1, maximum: 128 }, sizeY: { type: "integer", minimum: 1, maximum: 128 }, cells: { type: "array", minItems: 1, maxItems: 16, items: { type: "integer", minimum: -1, maximum: 128 } },
    } },
    surfacePose: { type: ["object", "null"], additionalProperties: false, required: ["name", "facing"], properties: { name: { const: "sit" }, facing: { type: "integer", minimum: 0, maximum: 3 } } },
  },
}
export const BLUEPRINT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", title: "Eggox blueprint file v1",
  type: "object", additionalProperties: false,
  required: ["format", "version", "display_name", "item_type", "size", "palette", "rotations", "frames"],
  properties: {
    format: { const: "eggox-blueprint" }, version: { const: 1 },
    id: { type: ["string", "null"] }, revision: { type: ["string", "null"] }, server: { type: "string" },
    display_name: { type: "string", minLength: 1, maxLength: 80 }, item_type: { enum: BLUEPRINT_RULES.item_types },
    size: { type: "object", additionalProperties: false, required: ["x", "y", "z"], properties: Object.fromEntries(["x", "y", "z"].map(k => [k, { type: "integer", minimum: 1, maximum: 128 }])) },
    palette: { type: "array", minItems: 1, maxItems: 256, items: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } },
    rotations: { enum: [1, 4] }, frames: { type: "array", minItems: 1, maxItems: 500, items: frameSchema },
    collision_height: { type: ["integer", "null"], minimum: 0, maximum: 512 },
    behavior: behaviorSchema,
    zones: { type: ["object", "null"] }, skeleton: { type: ["object", "null"] }, voxel_binding_b64: { type: ["string", "null"] },
  },
}

function assertBlueprint(ok, where, message) {
  if (!ok) throw new Fail(`${where}: ${message}`)
}
const object = v => v !== null && typeof v === "object" && !Array.isArray(v)
const integer = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
const shortName = v => typeof v === "string" && v.length > 0 && [...v].length <= 24
function knownKeys(value, keys, at) {
  assertBlueprint(object(value), at, "expected an object")
  for (const key of Object.keys(value)) assertBlueprint(keys.includes(key), `${at}.${key}`, "unknown field")
}

// A thing taller than one step (24 voxels) with no footprint and no
// collision height would offer its top as a floor nobody can climb to.
// Such a thing blocks its tiles unless its author says otherwise.
function blockedByDefault(doc) {
  // Seats, beds, water and wearables have their own rules for where a body goes.
  if (doc.item_type !== "solid" || doc.behavior?.footprint != null || doc.collision_height != null || !(doc.size?.z > 24)) return null
  const cells = Array(Math.ceil(doc.size.x / 32) * Math.ceil(doc.size.y / 32)).fill(-1)
  return {
    doc: { ...doc, behavior: { ...(doc.behavior || {}), footprint: { sizeX: doc.size.x, sizeY: doc.size.y, cells } } },
    warning: `${doc.size.z} voxels tall with no footprint: pushed as-is it blocks its tiles (players walk around it). Add behavior.footprint to make parts walkable or standable (-1 blocks, 0 passes, a height is a floor at that height).`,
    note: "no footprint was given, so it blocks its tiles; behavior.footprint changes that",
  }
}

function validateBehavior(b, doc) {
  if (b == null) return
  const at = "behavior", a = BLUEPRINT_RULES.animation, count = doc.frames.length
  knownKeys(b, ["clips", "states", "interactions", "frameGround", "footprint", "surfacePose"], at)
  const clips = b.clips ?? [], states = b.states ?? [], interactions = b.interactions ?? []
  for (const [key, list] of Object.entries({ clips, states, interactions }))
    assertBlueprint(Array.isArray(list) && list.length <= 12, `${at}.${key}`, "expected at most 12 entries")
  const owned = new Set(), names = new Set(), commands = new Set(), character = doc.item_type === "character"
  for (const [i, c] of clips.entries()) {
    const p = `${at}.clips[${i}]`, movement = ["walk", "idle"].includes(c?.name)
    knownKeys(c, ["name", "frames", "order", "loop", "command", "region", "whileMoving", "repeat"], p)
    assertBlueprint(shortName(c.name) && !names.has(c.name), p, "names must be unique, 1–24 characters")
    names.add(c.name)
    const cap = character ? (movement ? a.movement_owned_frames : a.command_owned_frames) : a.max_sequence
    assertBlueprint(Array.isArray(c.frames) && c.frames.length > 0 && c.frames.length <= cap, `${p}.frames`, `expected 1–${cap} frames`)
    for (const n of c.frames) {
      assertBlueprint(integer(n, 0, count - 1), `${p}.frames`, "frame does not exist")
      if (character) {
        assertBlueprint(!owned.has(n), `${p}.frames`, "character frames belong to exactly one clip")
        owned.add(n)
      }
    }
    if (c.order != null) assertBlueprint(character && Array.isArray(c.order) && c.order.length > 0 && c.order.length <= (movement ? a.movement_sequence : a.max_sequence) && c.order.every(n => integer(n, 0, c.frames.length - 1)), `${p}.order`, "expected positions into this character clip's owned frames")
    for (const key of ["loop", "whileMoving"]) if (c[key] !== undefined) assertBlueprint(typeof c[key] === "boolean", `${p}.${key}`, "expected boolean")
    if (c.repeat != null) assertBlueprint(integer(c.repeat, 1, a.max_repeat), `${p}.repeat`, "expected 1–20")
    if (c.region != null) assertBlueprint(shortName(c.region), `${p}.region`, "expected a zone name of 1–24 characters")
    if (c.command != null) {
      assertBlueprint(!movement && typeof c.command === "string" && /^[a-z0-9_-]{1,24}$/.test(c.command) && !a.reserved_commands.includes(c.command) && !commands.has(c.command), `${p}.command`, "invalid, reserved or repeated command")
      commands.add(c.command)
    }
  }
  const stateNames = new Set()
  for (const [i, state] of states.entries()) {
    const p = `${at}.states[${i}]`
    knownKeys(state, ["name", "clip", "onEnd"], p)
    assertBlueprint(shortName(state.name) && !stateNames.has(state.name) && names.has(state.clip), p, "expected unique state name and existing clip")
    stateNames.add(state.name)
  }
  for (const state of states) if (state.onEnd != null) assertBlueprint(stateNames.has(state.onEnd), at, "onEnd must name an existing state")
  for (const [i, interaction] of interactions.entries()) {
    const p = `${at}.interactions[${i}]`
    knownKeys(interaction, ["trigger", "action"], p)
    assertBlueprint(["walk_on", "walk_off", "click_in_range"].includes(interaction.trigger), p, "invalid trigger")
    knownKeys(interaction.action, ["kind", "state"], `${p}.action`)
    assertBlueprint(interaction.action.kind === "cycle" || (interaction.action.kind === "goto" && stateNames.has(interaction.action.state)), p, "expected cycle, or goto with an existing state")
  }
  if (b.frameGround != null) assertBlueprint(Array.isArray(b.frameGround) && b.frameGround.length <= count && b.frameGround.every(n => integer(n, 0, Math.min(64, doc.size.z))), `${at}.frameGround`, "ground levels must fit the frames and be between 0 and min(64, size.z)")
  if (b.footprint != null) {
    const p = b.footprint
    knownKeys(p, ["sizeX", "sizeY", "cells"], `${at}.footprint`)
    assertBlueprint(!character && p.sizeX === doc.size.x && p.sizeY === doc.size.y && Array.isArray(p.cells) && p.cells.length === Math.ceil(p.sizeX / 32) * Math.ceil(p.sizeY / 32) && p.cells.every(n => integer(n, -1, doc.size.z)), `${at}.footprint`, "must match object size; one height per tile, -1 blocks, 0 passes")
  }
  if (b.surfacePose != null) {
    knownKeys(b.surfacePose, ["name", "facing"], `${at}.surfacePose`)
    assertBlueprint(!character && b.surfacePose.name === "sit" && integer(b.surfacePose.facing, 0, 3), `${at}.surfacePose`, "expected sit with facing 0–3 on an object")
  }
}

function gridBytes(grid, doc, at) {
  assertBlueprint((grid.voxels !== undefined) !== (grid.voxels_b64 !== undefined), at, "supply voxels OR voxels_b64")
  if (grid.voxels_b64 === undefined) return voxelRows(grid.voxels, doc, at)
  assertBlueprint(typeof grid.voxels_b64 === "string", at, "voxels_b64 must be base64")
  const bytes = Buffer.from(grid.voxels_b64, "base64")
  assertBlueprint(bytes.length === doc.size.x * doc.size.y * doc.size.z && bytes.toString("base64") === grid.voxels_b64 && bytes.every(c => c < doc.palette.length), at, "dense grid must be canonical base64 of exactly one valid palette index per cell")
  return bytes
}

function voxelRows(rows, doc, at) {
  const { x: sx, y: sy, z: sz } = doc.size
  assertBlueprint(Array.isArray(rows) && rows.length <= sx * sy * sz, at, "expected [x,y,z,paletteIndex] rows, at most one per cell")
  const voxels = Buffer.alloc(sx * sy * sz), seen = new Set()
  for (const [i, row] of rows.entries()) {
    assertBlueprint(Array.isArray(row) && row.length === 4 && integer(row[0], 0, sx - 1) && integer(row[1], 0, sy - 1) && integer(row[2], 0, sz - 1) && integer(row[3], 0, doc.palette.length - 1), `${at}[${i}]`, "coordinate or palette index out of range")
    const offset = row[0] + row[1] * sx + row[2] * sx * sy
    assertBlueprint(!seen.has(offset), `${at}[${i}]`, "duplicate cell")
    seen.add(offset); voxels[offset] = row[3]
  }
  return voxels
}

function encodeRuns(bytes) {
  const out = Buffer.alloc(bytes.length * 2)
  let at = 0
  for (let i = 0; i < bytes.length;) {
    let n = 1
    while (n < 255 && i + n < bytes.length && bytes[i + n] === bytes[i]) n++
    out[at++] = n; out[at++] = bytes[i]; i += n
  }
  return out.subarray(0, at)
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const SOURCE_METADATA = ["display_name", "item_type", "collision_height", "behavior", "zones", "skeleton", "voxel_binding_b64"]

export function encodeBlueprint(doc) {
  knownKeys(doc, Object.keys(BLUEPRINT_SCHEMA.properties), "blueprint")
  assertBlueprint(doc.format === "eggox-blueprint" && doc.version === 1, "format", "expected eggox-blueprint version 1")
  assertBlueprint(typeof doc.display_name === "string" && doc.display_name.trim() && [...doc.display_name].length <= 80, "display_name", "expected 1–80 characters")
  assertBlueprint(BLUEPRINT_RULES.item_types.includes(doc.item_type), "item_type", "unknown item type")
  knownKeys(doc.size, ["x", "y", "z"], "size")
  assertBlueprint(["x", "y", "z"].every(k => integer(doc.size[k], 1, 128)), "size", "each axis must be 1–128 voxels")
  assertBlueprint([1, 4].includes(doc.rotations), "rotations", "expected 1 or 4")
  assertBlueprint(Array.isArray(doc.palette) && doc.palette.length >= 1 && doc.palette.length <= 256 && doc.palette.every(c => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)), "palette", "expected 1–256 #RRGGBB colors, index 0 is empty")
  assertBlueprint(Array.isArray(doc.frames) && doc.frames.length >= 1 && doc.frames.length <= 500, "frames", "expected 1–500 complete frames")
  if (doc.collision_height != null) assertBlueprint(integer(doc.collision_height, 0, 512), "collision_height", "expected 0–512")
  for (const k of ["behavior", "zones", "skeleton"]) if (doc[k] != null)
    assertBlueprint(object(doc[k]) && Buffer.byteLength(JSON.stringify(doc[k])) <= 200_000, k, "expected an object of at most 200000 JSON bytes")
  for (const k of ["id", "revision", "server"]) if (doc[k] != null) assertBlueprint(typeof doc[k] === "string" && doc[k].length > 0, k, "expected a nonempty string")
  const volume = doc.size.x * doc.size.y * doc.size.z
  if (doc.voxel_binding_b64 != null) {
    const binding = Buffer.from(doc.voxel_binding_b64, "base64")
    assertBlueprint(binding.toString("base64") === doc.voxel_binding_b64 && binding.length === volume, "voxel_binding_b64", "expected one bone-index byte per voxel, in canonical base64")
  }
  validateBehavior(doc.behavior, doc)
  // Count before allocating frame grids, including the optional layers trailer.
  const withLayers = doc.frames.some(f => f?.layers !== undefined)
  const grids = doc.frames.reduce((n, f) => n + 1 + (withLayers ? (Array.isArray(f?.layers) ? f.layers.length : 1) : 0), 0)
  assertBlueprint(grids * volume <= BLUEPRINT_RULES.max_decoded_bytes, "frames", "decoded grids exceed 64 MiB; use a smaller canvas or fewer frames/layers")
  const frameParts = [], trailer = [], palette = Buffer.from(doc.palette.flatMap(c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]))
  for (const [i, frame] of doc.frames.entries()) {
    const at = `frames[${i}]`
    knownKeys(frame, ["duration_ms", "voxels", "voxels_b64", "layers", "activeLayer"], at)
    assertBlueprint(frame.duration_ms === undefined || frame.duration_ms === 100, `${at}.duration_ms`, "every frame is exactly 100ms")
    assertBlueprint([frame.voxels, frame.voxels_b64, frame.layers].filter(v => v !== undefined).length === 1, at, "supply voxels OR voxels_b64 OR layers")
    const layers = frame.layers ?? [{ name: "layer 1", visible: true, ...(frame.voxels_b64 === undefined ? { voxels: frame.voxels } : { voxels_b64: frame.voxels_b64 }) }]
    assertBlueprint(Array.isArray(layers) && layers.length >= 1 && layers.length <= 12, at, "expected 1–12 layers")
    assertBlueprint(integer(frame.activeLayer ?? 0, 0, layers.length - 1), `${at}.activeLayer`, "layer does not exist")
    const composite = Buffer.alloc(volume)
    if (withLayers) trailer.push(Buffer.from([layers.length, frame.activeLayer ?? 0]))
    for (const [j, layer] of layers.entries()) {
      const lp = `${at}.layers[${j}]`
      knownKeys(layer, ["name", "visible", "voxels", "voxels_b64"], lp)
      assertBlueprint(typeof layer.name === "string" && [...layer.name].length <= 24 && typeof layer.visible === "boolean", lp, "expected name (up to 24 characters) and boolean visible")
      const bytes = gridBytes(layer, doc, lp)
      if (layer.visible) for (let k = 0; k < volume; k++) if (bytes[k]) composite[k] = bytes[k]
      if (withLayers) {
        const name = Buffer.from(layer.name), rle = encodeRuns(bytes)
        trailer.push(Buffer.from([layer.visible ? 1 : 0, name.length]), name, u32(rle.length), rle)
      }
    }
    const rle = encodeRuns(composite)
    frameParts.push(u32(100), u32(rle.length), rle)
  }
  const parts = [u16(3), u16(doc.size.x), u16(doc.size.y), u16(doc.size.z), u16(doc.palette.length), palette, Buffer.from([doc.rotations]), u16(doc.frames.length), ...frameParts]
  if (withLayers) parts.push(Buffer.from("EGLY"), Buffer.from([1]), ...trailer)
  assertBlueprint(parts.reduce((n, p) => n + p.length, 0) <= BLUEPRINT_RULES.max_source_bytes, "frames", "compressed source exceeds 6000000 bytes")
  const payload = { ...Object.fromEntries(SOURCE_METADATA.map(k => [k, doc[k] ?? null])), voxel_source_b64: Buffer.concat(parts).toString("base64") }
  assertBlueprint(Buffer.byteLength(JSON.stringify(payload)) + 1024 <= 10_000_000, "blueprint", "source and metadata exceed the 10 MB HTTP limit")
  return payload
}

export function decodeBlueprint(source) {
  const { voxel_source_b64, ...metadata } = source
  if (!voxel_source_b64) return { format: "eggox-blueprint", version: 1, ...metadata, size: { x: 32, y: 32, z: 32 }, palette: ["#000000", "#d98c45"], rotations: 4, frames: [{ voxels: [] }] }
  const bytes = Buffer.from(voxel_source_b64, "base64")
  assertBlueprint(bytes.length <= BLUEPRINT_RULES.max_source_bytes, "source", "source exceeds supported size")
  let offset = 0, budget = 0
  const read = n => {
    assertBlueprint(offset + n <= bytes.length, "source", "truncated source")
    const b = bytes.subarray(offset, offset + n); offset += n; return b
  }
  const word = () => read(2).readUInt16LE(), dword = () => read(4).readUInt32LE()
  assertBlueprint(word() === 3, "source", "only full schema-3 authoring sources can be edited")
  const size = { x: word(), y: word(), z: word() }, palette = [], volume = size.x * size.y * size.z
  assertBlueprint(Object.values(size).every(n => integer(n, 1, 128)), "source", "invalid dimensions")
  const colors = word()
  assertBlueprint(integer(colors, 1, 256), "source", "invalid palette")
  for (let i = 0; i < colors; i++) palette.push("#" + read(3).toString("hex"))
  const rotations = read(1)[0], count = word()
  assertBlueprint([1, 4].includes(rotations) && integer(count, 1, 500), "source", "invalid rotations or frame count")
  const rows = () => {
    budget += volume
    assertBlueprint(budget <= BLUEPRINT_RULES.max_decoded_bytes, "source", "decoded grids exceed 64 MiB")
    const rle = read(dword()), dense = Buffer.alloc(volume)
    let cell = 0, filled = 0
    assertBlueprint(rle.length % 2 === 0, "source", "odd RLE length")
    for (let i = 0; i < rle.length; i += 2) {
      const n = rle[i], color = rle[i + 1]
      assertBlueprint(n > 0 && color < colors && cell + n <= volume, "source", "invalid RLE run")
      if (color) { dense.fill(color, cell, cell + n); filled += n }
      cell += n
    }
    assertBlueprint(cell === volume, "source", "RLE underflow")
    if (filled > 4096) return { voxels_b64: dense.toString("base64") }
    const voxels = []
    for (let j = 0; j < volume; j++) if (dense[j]) voxels.push([j % size.x, Math.floor(j / size.x) % size.y, Math.floor(j / (size.x * size.y)), dense[j]])
    return { voxels }
  }
  const frames = []
  for (let i = 0; i < count; i++) {
    const ms = dword()
    assertBlueprint(ms === 100 || count === 1, "source", "invalid frame timing")
    frames.push({ duration_ms: 100, ...rows() })
  }
  if (offset < bytes.length) {
    assertBlueprint(read(5).equals(Buffer.from([69, 71, 76, 89, 1])), "source", "unknown layers trailer")
    for (const frame of frames) {
      const n = read(1)[0], active = read(1)[0], layers = []
      assertBlueprint(integer(n, 1, 12) && active < n, "source", "invalid layers")
      for (let i = 0; i < n; i++) {
        const visible = read(1)[0], name = read(read(1)[0]).toString("utf8")
        assertBlueprint(visible <= 1, "source", "invalid visibility")
        layers.push({ name, visible: !!visible, ...rows() })
      }
      delete frame.voxels
      delete frame.voxels_b64
      Object.assign(frame, { layers, activeLayer: active })
    }
  }
  assertBlueprint(offset === bytes.length, "source", "unexpected trailing bytes")
  return { format: "eggox-blueprint", version: 1, ...metadata, size, palette, rotations, frames }
}

function readBlueprint(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) }
  catch (e) { throw new Fail(`${file}: ${e.message}`) }
}
function saveBlueprint(file, doc, overwrite) {
  const text = JSON.stringify(doc, null, 2) + "\n"
  if (!overwrite && fs.existsSync(file)) throw new Fail(`${file} already exists; choose another file or use --force`)
  if (!overwrite) return fs.writeFileSync(file, text, { flag: "wx" })
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`
  try {
    fs.writeFileSync(temp, text, { flag: "wx" })
    fs.renameSync(temp, file)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}
function blueprintServer(flags, doc) {
  const server = serverFor({ ...flags, server: flags.server || process.env.EGGOX_SERVER || doc?.server })
  if (doc?.server && normalizeServer(doc.server) !== server) throw new Fail(`this blueprint belongs to ${doc.server}; pull it from ${server} before pushing there`)
  return server
}

async function blueprints(flags) {
  const r = await api(serverFor(flags), "GET", "/blueprints")
  if (r.status !== 200) refuse(r, "blueprints")
  if (flags.json) return print(r.data)
  if (r.data.blueprints.length === 0) console.log("No blueprints yet. Buy one in Eggox (the Studio); the CLI never spends your Voxels.")
  for (const b of r.data.blueprints) console.log(`${b.display_name} · ${b.kind} v${b.version}\n  ${b.id}`)
}
async function blueprint(flags, args) {
  const [action, ...rest] = args
  if (action === "render") return renderCommand("blueprint", flags, rest)
  if (action === "schema") return print({ schema: BLUEPRINT_SCHEMA, rules: BLUEPRINT_RULES })
  if (action === "init") {
    const file = rest[0] || "blueprint.json"
    const doc = decodeBlueprint({ display_name: "Untitled", item_type: "solid" })
    saveBlueprint(file, doc, flags.force)
    return print({ file, next: "Author frames locally. Buy and pull a blueprint to attach an id and revision before pushing." })
  }
  if (action === "check" || action === "push" || action === "frame") {
    const file = rest[0] || "blueprint.json", doc = readBlueprint(file)
    if (action === "frame") {
      const index = Number(rest[1])
      assertBlueprint(integer(index, 0, doc.frames.length), "frame", "index must replace a frame or append at frames.length")
      assertBlueprint(!!rest[2], "frame", "usage: eggox blueprint frame <file> <index> <frame.json>")
      doc.frames[index] = readBlueprint(rest[2])
    }
    const blocked = action === "frame" ? null : blockedByDefault(doc)
    const payload = encodeBlueprint(blocked && action === "push" ? blocked.doc : doc)
    if (action === "frame") { saveBlueprint(file, doc, true); return print({ file, frame: Number(rest[1]), ok: true }) }
    if (action === "check") {
      if (flags.remote) {
        const r = await api(blueprintServer(flags, doc), "POST", "/blueprints/check", payload)
        if (r.status !== 200) refuse(r, "blueprint check")
      }
      return print({ ok: true, file, frames: doc.frames.length, bytes: Buffer.byteLength(payload.voxel_source_b64, "base64"), remote: !!flags.remote, ...(blocked ? { warnings: [blocked.warning] } : {}) })
    }
    assertBlueprint(typeof doc.id === "string" && doc.id, "id", "pull a blueprint first; push needs its id")
    assertBlueprint(flags.force || typeof doc.revision === "string", "revision", "pull first, or explicitly push --force")
    const server = blueprintServer(flags, doc)
    const r = await api(server, "PUT", `/blueprints/${encodeURIComponent(doc.id)}`, { ...payload, revision: doc.revision, force: !!flags.force })
    if (r.status !== 200) refuse(r, "blueprint push")
    saveBlueprint(file, { ...(blocked ? blocked.doc : doc), id: r.data.item.id, revision: r.data.revision, server }, true)
    return print({ ...r.data, file, editor: `${server}/client`, ...(blocked ? { notes: [blocked.note] } : {}) })
  }
  const server = serverFor(flags)
  if (action === "buy") throw new Fail("the CLI never spends your Voxels: buy a blueprint in Eggox (the Studio), then eggox blueprints lists it")
  if (["pull", "history", "publish", "mint"].includes(action)) {
    const id = rest[0]
    assertBlueprint(typeof id === "string" && id.length > 0, "id", `usage: eggox blueprint ${action} <id>`)
    const route = `/blueprints/${encodeURIComponent(id)}`
    if (action === "pull") {
      const file = rest[1] || "blueprint.json"
      if (fs.existsSync(file) && !flags.force) throw new Fail(`${file} already exists; use a new filename or --force`)
      const r = await api(server, "GET", route)
      if (r.status !== 200) refuse(r, "blueprint pull")
      const doc = { ...decodeBlueprint(r.data.source), id: r.data.item.id, revision: r.data.revision, server }
      saveBlueprint(file, doc, flags.force)
      return print({ file, item: r.data.item, latest_id: r.data.latest_id })
    }
    if (action === "mint") assertBlueprint(integer(flags.count, 1, 10_000_000), "count", "supply --count 1..10000000; mint publishes this iteration permanently")
    const r = await api(server, ["mint", "publish"].includes(action) ? "POST" : "GET", `${route}/${action}`, action === "mint" ? { count: flags.count } : undefined)
    if (r.status !== 200) refuse(r, `blueprint ${action}`)
    return print(action === "history" ? groupHistory(r.data) : r.data)
  }
  throw new Fail("usage: eggox blueprint schema|init|pull|check|frame|push|history|publish|mint (see eggox docs blueprints)")
}

// Render images stay binary on disk and become native image content in MCP.
const RENDER_COMMON = {
  width: { type: "integer", minimum: 128, maximum: 1536, description: "Output pixels; width × height must be at most 1572864" },
  height: { type: "integer", minimum: 128, maximum: 1536 },
  rotation: { type: "integer", enum: [0, 90, 180, 270] },
  background: { type: "string", description: "#RRGGBB or transparent" },
  output: { type: "string", description: "Optional PNG filename. MCP always returns an inline image too." },
  force: { type: "boolean", description: "Allow overwriting output files" },
}
const RENDER_BLUEPRINT = {
  ...RENDER_COMMON,
  file: { type: "string", description: "Local blueprint JSON, including unsaved edits. Default blueprint.json; mutually exclusive with id." },
  id: { type: "string", description: "Owned saved blueprint/prototype; no browser required" },
  frame: { type: "integer", minimum: 0, maximum: 499, description: "Zero-based frame, default 0" },
  layers: { type: "array", minItems: 1, maxItems: 12, items: { type: "integer", minimum: 0, maximum: 11 }, description: "Isolate these layer indices, including hidden layers; default visible composite" },
  view: { type: "string", enum: ["iso", "top", "front"] },
}
const RENDER_EXPERIENCE = {
  ...RENDER_COMMON,
  dir: { type: "string", description: "Pulled project folder (default .). Render uses the server layout; push edits first." },
  game: { type: "string", description: "Owned game name/id instead of a project folder" },
  rooms: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" }, description: "Room names/ids. Omit for all rooms in a contact sheet (max 16)." },
  bounds: { type: "array", minItems: 4, maxItems: 4, items: { type: "integer" }, description: "[x,y,width,height] in tiles; select exactly one room" },
  focus: { type: "string", description: "Placement id to frame with margin; one room, mutually exclusive with bounds" },
  margin: { type: "integer", minimum: 0, maximum: 12 },
  hidden: { type: "boolean", description: "Include hidden stock, ghosted" },
  state: { type: "string", enum: ["draft", "published"], description: "Saved layout to inspect; scripts are not executed" },
  time_ms: { type: "integer", minimum: 0, maximum: 86400000, description: "Sample voxel flipbooks at this time (default 0)" },
  view: { type: "string", enum: ["auto", "iso", "top"] },
}

function renderOptions(kind, flags) {
  const schema = kind === "blueprint" ? RENDER_BLUEPRINT : RENDER_EXPERIENCE
  const body = {}
  for (const [key, rule] of Object.entries(schema)) {
    const value = flags[key]
    if (value === undefined) continue
    const valid = rule.type === "integer" ? integer(value, rule.minimum ?? 0, rule.maximum ?? 270)
      : rule.type === "array" ? Array.isArray(value) && value.length >= (rule.minItems ?? 0) && value.length <= (rule.maxItems ?? 100) && value.every(v => rule.items.type === "integer" ? Number.isInteger(v) : typeof v === "string")
      : typeof value === rule.type
    if (!valid || (rule.enum && !rule.enum.includes(value))) throw new Fail(`invalid render option: ${key}`)
    if (!["file", "id", "dir", "game", "output", "force"].includes(key)) body[key] = value
  }
  if ((body.width ?? 1024) * (body.height ?? 768) > 1572864) throw new Fail("render image exceeds 1572864 pixels")
  if (body.background && body.background !== "transparent" && !/^#[\da-f]{6}$/i.test(body.background)) throw new Fail("background must be #RRGGBB or transparent")
  if (body.bounds && body.focus) throw new Fail("choose bounds or focus")
  return body
}

async function requestRender(kind, flags, args = [], inline = false) {
  const body = renderOptions(kind, flags)
  const output = flags.output ? path.resolve(flags.output) : inline ? null : path.resolve(`${kind}.png`)
  const metadataFile = output && `${output}.json`
  for (const file of [output, metadataFile].filter(Boolean)) {
    if (fs.existsSync(file) && !flags.force) throw new Fail(`${file} already exists; choose --output or --force`)
    if (!fs.existsSync(path.dirname(file))) throw new Fail(`output directory does not exist: ${path.dirname(file)}`)
  }
  let server, route
  if (kind === "blueprint") {
    if (flags.id && args[0]) throw new Fail("choose a local blueprint file or --id")
    if (flags.id) {
      server = serverFor(flags); route = `/blueprints/${encodeURIComponent(flags.id)}/render`
    } else {
      const doc = readBlueprint(args[0] || "blueprint.json")
      if ((body.frame ?? 0) >= doc.frames.length) throw new Fail("frame is outside this blueprint")
      server = blueprintServer(flags, doc); route = "/blueprints/render"
      body.source = encodeBlueprint(doc)
    }
  } else {
    const dir = path.resolve(args[0] || ".")
    server = serverFor(flags, flags.game ? undefined : dir)
    const game = flags.game ? await resolveGame(server, flags.game) : gameOf(dir)
    route = `/games/${ref(game.id)}/render`
  }
  const r = await api(server, "POST", route, body, { maxBytes: 3_000_000 })
  if (r.status !== 200) refuse(r, "render")
  const image = r.data?.image
  if (image?.mime_type !== "image/png" || typeof image.data !== "string") throw new Fail("server did not return a PNG")
  const bytes = Buffer.from(image.data, "base64")
  if (bytes.length > 2_000_000 || bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Fail("invalid PNG response")
  const summary = { ...(output ? { file: output, metadata_file: metadataFile } : {}),
    width: image.width, height: image.height, bytes: bytes.length, quota: r.data.quota, metadata: r.data.metadata }
  if (output) {
    fs.writeFileSync(output, bytes, { flag: flags.force ? "w" : "wx" })
    fs.writeFileSync(metadataFile, JSON.stringify(summary, null, 2) + "\n", { flag: flags.force ? "w" : "wx" })
  }
  return { summary, content: [{ type: "image", mimeType: "image/png", data: image.data }, { type: "text", text: JSON.stringify(summary) }] }
}

async function renderCommand(kind, flags, args) {
  const { summary } = await requestRender(kind, flags, args)
  print(summary)
}

async function renderQuota(flags) {
  const r = await api(serverFor(flags), "GET", "/renders/quota")
  if (r.status !== 200) refuse(r, "render quota")
  print(r.data)
}

// ── MCP over stdio ────────────────────────────────────────────────

const blueprintTool = (action, description, properties = {}, required = []) => ({
  name: `eggox_blueprint_${action}`, description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
})
const bpFile = { file: { type: "string", description: "Local blueprint JSON file (default blueprint.json). Large voxel data stays on disk." } }
const bpId = { id: { type: "string", description: "Owned blueprint or prototype id" } }
const bpForce = { force: { type: "boolean", description: "Explicitly allow overwriting the file or branching from a stale iteration" } }
const BLUEPRINT_TOOLS = [
  { name: "eggox_blueprints", description: "List owned blueprints and latest prototypes. Blueprints are bought by the user in Eggox; tools never buy them.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  blueprintTool("schema", "Offline JSON schema and all voxel frame authoring limits. Generate files locally; upload complete frames in one push."),
  blueprintTool("init", "Create an empty local blueprint file, without spending Voxels.", { ...bpFile, ...bpForce }),
  blueprintTool("pull", "Download a blueprint/prototype with complete frames, layers and metadata to a local file. Never returns voxel arrays through MCP.", { ...bpId, ...bpFile, ...bpForce }, ["id"]),
  blueprintTool("check", "Validate a local blueprint offline. Set remote for authoritative server validation without saving.", { ...bpFile, remote: { type: "boolean" } }),
  blueprintTool("frame", "Replace a complete frame from a local JSON file, or append at frames.length. Validates the whole document before writing.", { ...bpFile, index: { type: "integer", minimum: 0 }, frame_file: { type: "string" } }, ["index", "frame_file"]),
  blueprintTool("push", "Save a local blueprint as a new draft iteration. Updates the file's id and revision. Rejects concurrent editor changes unless force.", { ...bpFile, ...bpForce }),
  blueprintTool("history", "List this blueprint lineage's saved iterations.", bpId, ["id"]),
  blueprintTool("publish", "Permanently publish a saved blueprint iteration without issuing another supply. Use only when the user asks to publish the item.", bpId, ["id"]),
  blueprintTool("mint", "Permanently publish this prototype iteration and mint its edition supply on the user's behalf. One mint per lineage. Call only when the user wants to mint, not to save a draft.", { ...bpId, count: { type: "integer", minimum: 1, maximum: 10000000 } }, ["id", "count"]),
]

const TOOLS = [
  { name: "eggox_blueprint_render", description: "See any blueprint frame using the server's canonical voxel renderer. Returns a PNG image, optionally saves it. Local edits need no push. Costs one hourly account render.", inputSchema: { type: "object", properties: RENDER_BLUEPRINT, additionalProperties: false } },
  { name: "eggox_render", description: "See a whole experience layout, selected rooms, or a tile section/placement close-up. Returns a PNG image and placement coordinates. Push local changes first. Static layout only: no script execution, players or HUD. Costs one hourly account render.", inputSchema: { type: "object", properties: RENDER_EXPERIENCE, additionalProperties: false } },
  { name: "eggox_render_quota", description: "Check the remaining account render allowance and reset time. Does not consume a render.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  ...BLUEPRINT_TOOLS,
  { name: "eggox_games", description: "The games the logged-in creator owns: id, name, rooms, published or not.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "eggox_pull", description: "Pull a game (by name or id) as files into a folder. Returns the folder and the file list.", inputSchema: { type: "object", properties: { game: { type: "string" }, dir: { type: "string", description: "folder to write into (default: the game's name)" } }, required: ["game"], additionalProperties: false } },
  { name: "eggox_playtest", description: "Play the pushed draft headless on the server and return what its scripts did: per step (enter, then click/key/ui/walk/wait/close/leave) every effect (window, set_state, floor, move, save, send, log...) and every handler error, plus the saves and any limit hit. Push first, or set push. Steps: a string like 'click Kettle; key space; ui brew 3; wait 2; expect save brews = 1' or a JSON list like [{\"click\":\"Kettle\"},{\"key\":\"space\"},{\"expect\":\"window shop\"}]. A walk, click or key waits until the player stands still; each step reports the room and tile. expect checks: save <k> = <json>, save <k> unset, game_save <k> = <json>, window <id>, no window, state <thing or x,y> = <state>, at <x,y>, room <name>, log <text>, no errors; failures are listed in failures and ok is false. Saves persist between runs until reset. Waits are real time, 60 s at most.", inputSchema: { type: "object", properties: { dir: { type: "string" }, steps: { description: "the scenario", oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }] }, room: { type: "string", description: "start in this room (default the root)" }, reset: { type: "boolean", description: "forget playtest saves first" }, saves: { type: "object", description: "saves put in before the run: {player: {key: value}, game: {key: value}}", properties: { player: { type: "object" }, game: { type: "object" } }, additionalProperties: false }, seed: { type: "integer", description: "seed math.random so runs repeat" }, push: { type: "boolean", description: "push the folder first" } }, additionalProperties: false } },
  { name: "eggox_logs", description: "The last playtest of the game (the human's in the browser, or a headless one): logs, handler errors, limits hit, with times and rooms.", inputSchema: { type: "object", properties: { dir: { type: "string" } }, additionalProperties: false } },
  { name: "eggox_check", description: "Would the project in a folder work? Returns what would change, or errors as file:line: text.", inputSchema: { type: "object", properties: { dir: { type: "string" } }, additionalProperties: false } },
  { name: "eggox_push", description: "Make the game match the project in a folder (its draft; the human plays it in Eggox). Refused if the game changed since the pull unless force.", inputSchema: { type: "object", properties: { dir: { type: "string" }, force: { type: "boolean" } }, additionalProperties: false } },
  { name: "eggox_bag", description: "The mints in the creator's bag (things a game can hold).", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "eggox_stock", description: "The things a game holds, with how many stand where.", inputSchema: { type: "object", properties: { dir: { type: "string" } }, additionalProperties: false } },
  { name: "eggox_stock_use", description: "Show another published version of a thing in the game's stock: the thing and every instance standing switch together. Free; only versions the author published.", inputSchema: { type: "object", properties: { item: { type: "string", description: "the thing's name or id, as eggox_stock lists it" }, version: { description: "a version number, or \"latest\"", oneOf: [{ type: "integer" }, { type: "string", enum: ["latest"] }] }, dir: { type: "string" } }, required: ["item", "version"], additionalProperties: false } },
  { name: "eggox_stock_add", description: "Put a mint from the bag into the game's stock, so rooms can place it by name.", inputSchema: { type: "object", properties: { item: { type: "string", description: "the mint's name or id" }, dir: { type: "string" } }, required: ["item"], additionalProperties: false } },
  { name: "eggox_entrance", description: "Read an experience entrance (or, with room, the door into one of its rooms), use a mint from its game's stock, or reset to the floor star. Changes apply immediately outside; they do not publish the game. Custom art keeps its shape and walking rules.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["get", "set", "reset"] }, item: { type: "string", description: "stock mint name or id; required for set" }, room: { type: "string", description: "a room of the game: its door instead of the game's own entrance" }, dir: { type: "string" } }, additionalProperties: false } },
  { name: "eggox_docs", description: "The reference as markdown: 'api' (the scripting API: events, verbs, bricks) or 'project' (the file format and the CLI), or 'blueprints' (complete voxel authoring and minting contract). Read both before writing a game.", inputSchema: { type: "object", properties: { page: { type: "string", enum: ["api", "project", "blueprints"] } }, required: ["page"], additionalProperties: false } },
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
        const f = { ...flags, json: false, force: !!a.force, remote: !!a.remote, count: a.count }
        let text
        try {
          if (params.name === "eggox_blueprint_render" || params.name === "eggox_render") {
            const kind = params.name === "eggox_render" ? "experience" : "blueprint"
            const { content } = await requestRender(kind, { ...flags, ...a }, kind === "blueprint" ? [a.file] : [a.dir], true)
            reply({ content })
            continue
          }
          text = await capture(async () => {
            switch (params.name) {
              case "eggox_render_quota": return renderQuota(f)
              case "eggox_blueprints": return blueprints({ ...f, json: true })
              case "eggox_blueprint_schema": return blueprint(f, ["schema"])
              case "eggox_blueprint_init": return blueprint(f, ["init", a.file])
              case "eggox_blueprint_pull": return blueprint(f, ["pull", a.id, a.file])
              case "eggox_blueprint_check": return blueprint(f, ["check", a.file])
              case "eggox_blueprint_frame": return blueprint(f, ["frame", a.file || "blueprint.json", a.index, a.frame_file])
              case "eggox_blueprint_push": return blueprint(f, ["push", a.file])
              case "eggox_blueprint_history": return blueprint(f, ["history", a.id])
              case "eggox_blueprint_publish": return blueprint(f, ["publish", a.id])
              case "eggox_blueprint_mint": return blueprint(f, ["mint", a.id])
              case "eggox_games": return games(f)
              case "eggox_pull": return pull(f, [a.game, a.dir].filter(Boolean))
              case "eggox_check": return check(f, [a.dir || "."])
              case "eggox_push": return push(f, [a.dir || "."])
              case "eggox_playtest": {
                // A failed run is in the answer; it does not end the server's exit code.
                const code = process.exitCode
                return playtest({ ...f, json: true, steps: a.steps, rooms: a.room ? [a.room] : undefined, reset: !!a.reset, push: !!a.push, saveValues: a.saves, seed: a.seed }, [a.dir || "."]).then(() => { process.exitCode = code })
              }
              case "eggox_logs": return logs({ ...f, json: true }, [a.dir || "."])
              case "eggox_bag": return bag(f)
              case "eggox_stock": return stock(f, [a.dir || "."])
              case "eggox_stock_add": return stock(f, ["add", a.item, a.dir || "."])
              case "eggox_stock_use": return stock(f, ["use", a.item, String(a.version), a.dir || "."])
              case "eggox_entrance": {
                const action = a.action || "get"
                if (!["get", "set", "reset"].includes(action)) throw new Fail("entrance action must be get, set or reset")
                if (action === "set" && !a.item) throw new Fail("entrance set needs a stock mint name or id")
                return entrance({ ...f, json: true, rooms: a.room ? [a.room] : undefined }, action === "get" ? [a.dir || "."] : action === "set" ? ["set", a.item, a.dir || "."] : ["reset", a.dir || "."])
              }
              case "eggox_docs": {
                const server = serverFor(f)
                const res = await fetch(`${server}/developers/${a.page === "blueprints" ? "blueprints" : a.page === "project" ? "project" : "v1"}.md`)
                if (!res.ok) throw new Fail(`documentation unavailable (${res.status})`)
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

async function main() {
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
  playtest: () => playtest(flags, args),
  logs: () => logs(flags, args),
  bag: () => bag(flags),
  blueprints: () => blueprints(flags),
  blueprint: () => blueprint(flags, args),
  render: () => renderCommand("experience", flags, args),
  renders: () => renderQuota(flags),
  stock: () => stock(flags, args),
  entrance: () => entrance(flags, args),
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

}

if (process.argv[1] && fs.existsSync(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main()
