# eggox

Your Eggox games as files on your own machine. Log in once, pull a game,
work on the files with any editor or AI agent, check, push, publish.

    curl -fsSL https://eggox.net/cli/install.sh | sh    # needs node 18+
    eggox login
    eggox games
    eggox pull "Ninja Skybound"
    cd "Ninja Skybound"
    eggox check
    eggox push

The project format and every command: https://eggox.net/developers/project.
`eggox mcp` serves the same commands to an AI agent over stdio.
