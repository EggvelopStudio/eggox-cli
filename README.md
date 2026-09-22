<p align="center">
  <a href="https://dev.eggox.net"><img src="https://eggox.net/landing/hero.png" alt="Eggox" width="640"></a>
</p>

<h1 align="center">eggox</h1>

<p align="center">
  Your <a href="https://eggox.net">Eggox</a> games as files on your own machine.<br>
  Log in once, pull a game, work on it with any editor or an AI agent, check, push, publish.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@eggox/cli"><img alt="npm version" src="https://img.shields.io/npm/v/%40eggox%2Fcli?style=flat-square&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/@eggox/cli"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40eggox%2Fcli?style=flat-square&color=cb3837"></a>
  <a href="https://nodejs.org"><img alt="node 18+" src="https://img.shields.io/badge/node-%E2%89%A518-5c9c4a?style=flat-square&logo=node.js&logoColor=white"></a>
  <a href="./LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-d68a3b?style=flat-square"></a>
  <a href="https://dev.eggox.net"><img alt="docs" src="https://img.shields.io/badge/docs-dev.eggox.net-1d5f6e?style=flat-square"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#a-game-is-a-folder">A game is a folder</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#for-ai-agents">For AI agents</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## Install

```sh
npm install -g @eggox/cli
```

No npm? The site hands out the same file. Needs node 18 or newer.

```sh
curl -fsSL https://eggox.net/cli/install.sh | sh
```

One file, no dependencies. `eggox --help` prints the version and every command.

## Quick start

### See what you build

```sh
eggox blueprint render blueprint.json --frame 2 --rotation 90 --output frame.png
eggox render ./my-game --output overview.png
eggox render ./my-game --room Arena --bounds 4,6,12,8 --output section.png
eggox renders   # shared hourly allowance and reset time
```

Blueprint previews include unsaved local edits. Experience previews read the server's draft or published layout, so push local changes first. Select layers, rooms, tile bounds or a placement to focus, and control view, rotation, dimensions and background. Images and selection metadata are saved together; existing files require `--force` to overwrite. Experience snapshots do not execute scripts or include players/HUD effects.

MCP exposes `eggox_blueprint_render`, `eggox_render`, and `eggox_render_quota`. The render tools return native image content directly to the agent. The default server allowance is 30 render attempts per account per UTC hour, shared across all tokens and both render types. See [the render reference](https://dev.eggox.net/cli/render), also included in `eggox docs project` and `eggox docs blueprints`.

### Edit a game

```sh
eggox login                      # a browser opens once
eggox games                      # the games you own
eggox pull "Ninja Skybound"      # the game as files, into a folder
cd "Ninja Skybound"

$EDITOR "rooms/Skybound/room.json"

eggox check                      # would it work? errors as file:line
eggox push                       # the game matches the files: it is the draft now
eggox publish                    # from now on the door leads here
```

```
$ eggox push
~ rooms/Skybound/room.json
Skybound: 1 placed, 1 picked up
9 other rooms as they were.
Pushed. The game is the draft now; open it in Eggox to play it, or eggox publish.
```

## A game is a folder

Everything a game is, as text. Keep it in git, diff it, review it, generate it.

```
eggox.json                the game: its name, API version, its rooms
rooms/<Room>/room.json    one room: size, view, chat; its rules; what stands where
rooms/<Room>/<file>.lua   the room's script files, compiled in name order
things/<Thing>.lua        the script on a thing (every one of it, in every room)
things/<Thing>.json       the bricks on a thing
```

A **room** has settings, rules (bricks on the game: rounds, winner, teams, lives, score, welcome) and script files. A **thing** is a mint in the game's stock; rooms place it by name, as many times as they like, and what is set on the thing holds for every one placed. **Bricks** are behaviour you pick from a list (spawn, goal, pickup, hazard, finish, door, sign, switch, action). **Scripts** are Lua, run on the server, for everything the bricks do not cover.

```json
{
  "rules": [
    { "kind": "rounds", "seconds": 90, "min": 2, "countdown": 5, "results": 8 },
    { "kind": "winner", "by": "points" },
    { "kind": "score", "name": "COINS" }
  ],
  "things": [
    { "thing": "Stone Pad", "x": 12, "y": 12, "bricks": [{ "kind": "spawn" }] },
    { "thing": "Gold Coin", "x": 8, "y": 6 }
  ]
}
```

The Studio inside Eggox and these files are two views of one game: a push shows up in the Studio, a save in the Studio shows up in the next pull. The whole format: [dev.eggox.net/project/folder](https://dev.eggox.net/project/folder).

## Commands

| command | does |
| --- | --- |
| `eggox login [--server URL]` | log in (a browser opens once) |
| `eggox logout` | forget the login |
| `eggox whoami` | who is logged in, on which server |
| `eggox games` | the games you own |
| `eggox pull <game> [dir]` | the game as files, by name or id |
| `eggox check [dir]` | would these files work? compile errors by line, playability warnings |
| `eggox push [dir] [--force]` | make the game match the files, whole or not at all |
| `eggox publish [dir]` | ship the draft: the door leads here from now on |
| `eggox bag` | the mints in your bag |
| `eggox entrance [set <mint>\|reset] [dir]` | use stock artwork for the entrance or restore its floor star |
| `eggox stock [add\|take] [..]` | the things the game holds; put one in, take one back |
| `eggox docs [api\|project]` | the reference as markdown |
| `eggox mcp` | serve all of this to an AI agent over MCP |
| `eggox update` | fetch the newest eggox from the server |

Every command takes `--server URL` and `--json`. `EGGOX_TOKEN` logs in without a browser (CI, a sandbox). One page per command: [dev.eggox.net/cli](https://dev.eggox.net/cli/overview).

## Checks, on the server

`check` and `push` send the folder to Eggox, which compiles every script and brick, dry-runs every placement, and asks whether the game can be played: a spawn to start on, a winner for the rounds, doors that lead somewhere, switches that switch something. Errors refuse the push and name the file and line. Playability findings warn on a push and refuse a publish, so a half-built draft is yours to work on and an unplayable one never ships. The same rules run for the Studio and are kept per API version. [The full table](https://dev.eggox.net/project/pushing).

## For AI agents

Everything is text and every command is here, so an agent can build a whole game from the docs while you watch it land in Eggox.

```json
{ "mcpServers": { "eggox": { "command": "eggox", "args": ["mcp"] } } }
```

The tools are `eggox_games`, `eggox_pull`, `eggox_check`, `eggox_push`, `eggox_bag`, `eggox_stock`, `eggox_stock_add`, `eggox_entrance` and `eggox_docs`. There is no game-publish tool on purpose: an agent pushes all day, a person ships. Every docs page is also markdown (add `.md`), [dev.eggox.net/llms.txt](https://dev.eggox.net/llms.txt) lists them all, and projects follow `AGENTS.md` guidelines.

> Read the eggox docs for the project format, the bricks and the scripting API. Pull "My Game". Make a race: a spawn, a finish, rounds of two minutes, and a sign at the start that explains it. Check until it passes, push, and tell me what you changed.

## How it works

- **Login** is OAuth with PKCE against your Eggox server, through a loopback port. The token is kept in `~/.config/eggox/credentials.json`, readable by you alone, and renews itself. Nothing on the API answers without it.
- **Pull** writes the folder and remembers the game and the revision in `.eggox/state.json`. A push carries that revision, so a change made elsewhere since is not overwritten by accident (`--force` if you mean it).
- **Push** is one transaction on the server: either the whole folder lands or nothing changes.
- **Servers**: eggox.net by default; `--server` or `EGGOX_SERVER` for another one, such as a staging server.

## Blueprint files

Build complete voxel frames locally, then push an iteration for final touches in
the editor. The editor can stay closed while your scripts or agent work.

```sh
eggox login                       # approve creator access once
eggox blueprints                  # select an owned blueprint
eggox blueprint pull bp_ID chair.json
eggox blueprint schema            # offline rules and JSON schema
# Generate or edit chair.json locally
eggox blueprint check chair.json
eggox blueprint push chair.json
# When you want editions, use the saved prototype id:
eggox blueprint mint pt_ID --count 10
```

The JSON file supports sparse rows or dense voxel bytes, layers and animation
metadata. `eggox blueprint buy` purchases a new blank blueprint with Voxels.
`history` lists iterations, `publish` publishes one without issuing new supply.
Pushing saves a draft; minting publishes permanently and creates the editions.


Blueprints use the same login and MCP process. `eggox_blueprints` lists your items;
`eggox_blueprint_schema` exports the offline frame contract. The
`eggox_blueprint_init`, `pull`, `check`, `frame`, `push`, and `history` tools work
with files, keeping voxel arrays out of tool replies. `eggox_blueprint_buy` spends
Voxels; `eggox_blueprint_publish` and `eggox_blueprint_mint` perform explicit,
permanent item actions when requested by the user. Old games-only logins need
`eggox login` again to approve creator access. See
[Blueprint files](https://dev.eggox.net/studio/blueprints), or `eggox docs blueprints`.

## Contributing

Issues and pull requests are welcome here. The file is mirrored from the Eggox monorepo, so a merged change lands in the next release; releases are tags (`v0.1.4`) and publish to npm from this repo's workflow. `main` is what eggox.net runs, `staging` is what is on its way.

## License

MIT, Eggvelop ApS.

### Custom experience entrances

```sh
eggox stock add "Cat Door"
eggox entrance set "Cat Door"
eggox entrance --json
eggox entrance reset
```

Choose an existing stock mint by name or id. The entrance retains its shape and
walking rules; authors must leave the entry tile accessible. The mint remains in
stock and can still be instanced inside. Reset or change entrances using it
before taking it back to the bag. Changes apply immediately without publishing
gameplay; project check/push leave this setting alone. Studio offers the same
control under **Entrance Appearance**. MCP exposes `eggox_entrance` with `action`,
`item` and `dir`. See the server’s `/cli/entrance` documentation.
