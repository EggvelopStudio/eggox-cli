# @eggox/cli

Your [Eggox](https://eggox.net) games as files on your own machine. Log in
once, pull a game, work on the files with any editor or an AI agent, check,
push, publish.

```
npm install -g @eggox/cli                            # or: npx @eggox/cli
curl -fsSL https://eggox.net/cli/install.sh | sh    # without npm; needs node 18+

eggox login
eggox games
eggox pull "Ninja Skybound"
cd "Ninja Skybound"
eggox check
eggox push
```

The project format and every command are documented at
[dev.eggox.net](https://dev.eggox.net). `eggox mcp` serves the same commands
to an AI agent over stdio.

One file, no dependencies, node 18 or newer. Issues and pull requests are
welcome here; the file is mirrored from the Eggox monorepo, so a merged change
lands in the next release.

MIT, Eggvelop ApS.
