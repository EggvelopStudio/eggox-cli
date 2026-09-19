# eggox

Your Eggox games as files on your own machine. Log in once, pull a game,
work on the files with any editor or AI agent, check, push, publish.

    npm install -g ./cli        # from this repo, until it is on npm
    eggox login
    eggox games
    eggox pull "Ninja Skybound"
    cd "Ninja Skybound"
    eggox check
    eggox push

The project format and every command: https://eggox.net/developers/project.
`eggox mcp` serves the same commands to an AI agent over stdio.
