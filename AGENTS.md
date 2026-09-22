# Eggox CLI — Agent Guidelines

This directory contains the source and distribution configuration for **`@eggox/cli`**, the official command-line tool and Model Context Protocol (MCP) server for Eggox creators and AI agents.

---

## 1. Overview & Architecture

- **Package**: `@eggox/cli` (binary name: `eggox`).
- **Zero External Dependencies**: Implemented in a single ES module file (`bin/eggox.mjs`) using native Node.js standard libraries (`node:fs`, `node:path`, `node:http`, `node:crypto`, `node:readline`, `node:child_process`). Runs on Node 18+.
- **Authentication**:
  - Interactive login via OAuth PKCE against the configured Eggox server, opening a temporary local HTTP loopback listener.
  - Headless/agent authentication supported via the `EGGOX_TOKEN` environment variable.
  - Credentials stored securely in `~/.config/eggox/credentials.json`.
- **Target Servers**:
  - Defaults to `https://eggox.net` (production) or `https://staging.eggox.net` (staging).
  - Configurable via `--server URL` or `EGGOX_SERVER`.

---

## 2. CLI Commands

| Command | Purpose |
|---|---|
| `eggox login [--server URL]` | Authenticates via browser OAuth PKCE loopback |
| `eggox logout` | Removes cached credentials |
| `eggox whoami` | Displays currently authenticated user and server |
| `eggox games` | Lists games owned by the authenticated account |
| `eggox pull <game> [dir]` | Downloads a game folder (rooms, scripts, bricks, stock) |
| `eggox check [dir]` | Validates Lua syntax, brick configurations, and playability rules on the server |
| `eggox push [dir] [--force]` | Uploads local changes as a working draft |
| `eggox publish [dir]` | Publishes the draft to live players (human-only step) |
| `eggox bag` | Lists available minted voxel items in the player's inventory bag |
| `eggox stock [dir]` | Lists items assigned to the game's stock |
| `eggox stock add <mint> [dir]` | Transfers an item from the player bag to game stock |
| `eggox stock take <thing> [dir]`| Returns an unplaced thing from game stock back to bag |
| `eggox entrance [dir]` | Lists the current entrance appearance and game stock choices |
| `eggox entrance set <mint> [dir]` | Uses a game-stock mint as the entrance, retaining its shape and walking rules |
| `eggox entrance reset [dir]` | Restores the default floor star |
| `eggox docs [api\|project]` | Outputs documentation reference as Markdown |
| `eggox mcp` | Starts an MCP server communicating over stdio JSON-RPC |
| `eggox update` | Updates the CLI to the latest version |

---

## 3. MCP Server for AI Agents (`eggox mcp`)

Running `eggox mcp` runs a standard JSON-RPC Model Context Protocol (MCP) server over `stdio`. It exposes tools directly to AI coding assistants:
- `eggox_games`: List games owned by the account.
- `eggox_pull`: Pull game source files into a folder.
- `eggox_check`: Validate scripts and bricks against server validation rules.
- `eggox_push`: Update the game draft.
- `eggox_bag`: Inspect player inventory items.
- `eggox_stock` & `eggox_stock_add`: Manage game things and stock.
- `eggox_entrance`: Read, set or reset the outside entrance appearance immediately, separately from gameplay publication.
- `eggox_docs`: Fetch API and project documentation.

> **Design Principle**: There is intentionally **no game `publish` tool** in MCP. AI agents may pull, edit, check, and push drafts; publishing to production is always a deliberate human decision.

---

## 4. Development & Maintenance Guidelines

1. **Keep Zero Dependencies**: Do not add runtime npm dependencies. All HTTP requests, JSON parsing, crypto, and file I/O must remain in native Node.js.
2. **Backwards Compatibility**: The CLI interacts with both local dev servers, staging, and production. Maintain backwards-compatible API contracts with `server/lib/eggox_web/controllers/api/`.
3. **Publishing Releases**:
   - Releases are tagged and published via `.github/workflows/release.yml` or using `tools/dev/publish-cli-repo.sh`.
   - Update `VERSION` in `bin/eggox.mjs` and `package.json` in sync.


## Blueprint authoring

The CLI also exports `BLUEPRINT_RULES`, `BLUEPRINT_SCHEMA`, `encodeBlueprint` and
`decodeBlueprint` from its single file. Keep them aligned with
`client/src/voxel/format.ts` and `Eggox.VoxelItems.Authoring`/`Behavior`. Blueprint
files use sparse complete frames and preserve hidden layers and metadata.
`eggox blueprint` supports schema/init/pull/check/frame/push/history/publish/mint.
Creator OAuth consent grants item publication/minting and never spending: the CLI
and MCP must not buy anything or spend Voxels, Stars or Gold; never widen existing games/editor grants. MCP includes these
explicit item actions, while game publication remains a human CLI step.

Tests: `node --test test/blueprint.test.mjs`. The monorepo codec compatibility test
also needs Node 22: `node --experimental-strip-types --test test/blueprint-codec.test.mjs`.
