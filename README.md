# Oak

Oak is a Discord bot that drives a local `codex app-server` and keeps one Codex thread per Discord thread.

## Requirements

- Node.js 20.11+
- `codex` installed locally and already logged in
- A Discord bot token
- Discord intents:
  - `MESSAGE CONTENT INTENT`
- Discord permissions:
  - Read messages / view channels
  - Send messages
  - Create public threads
  - Send messages in threads
  - Read message history
  - Use application commands

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm start
```

By default Oak starts `codex app-server --listen ws://127.0.0.1:4789`.

## Config

Required:

- `OAK_DISCORD_TOKEN`

Recommended:

- `OAK_OWNER_ID`

Optional Codex defaults:

- `OAK_CODEX_BIN`
- `OAK_CODEX_WS_URL`
- `OAK_CODEX_MODEL`
- `OAK_CODEX_REASONING_EFFORT`
- `OAK_CODEX_REASONING_SUMMARY`
- `OAK_CODEX_SERVICE_TIER`
- `OAK_TURN_TIMEOUT_MS`
- `OAK_TYPING_INTERVAL_MS`

Optional first-run bootstrap:

- `OAK_BOOTSTRAP_WORKSPACE_ROOT`
- `OAK_BOOTSTRAP_WORKSPACE_KEY`
- `OAK_BOOTSTRAP_GUILD_ID`
- `OAK_BOOTSTRAP_CHANNEL_ID`
- `OAK_BOOTSTRAP_ALLOWED_USER_IDS`

If `OAK_BOOTSTRAP_WORKSPACE_ROOT` is unset, Oak starts with an empty access config and you configure routing with `/oak-config`.

## Runtime Files

Oak writes local state to `.runtime/`:

- `config.json`: workspaces, routes, access
- `sessions.json`: Discord thread to Codex thread mappings
- `attachments/`: downloaded message attachments

Older checkouts may still have `oak/.runtime/`. New setups should use `.runtime/`.

## Discord Usage

Examples below assume the bot is named `Oak`.

Start a session:

- Mention the bot in a routed text channel to create a thread-backed session
- In an Oak thread, send a normal message to continue the session
- In an uninitialized thread, mention the bot once to start session state

Mention commands:

- `@Oak model`
- `@Oak stop`
- `stop` or `cancel` inside an Oak thread
- `@Oak rate limits`
- `@Oak codex switch`
- `@Oak restart bot`
- `@Oak restart codex`

Slash command:

- `/oak-config workspace set|remove|list`
- `/oak-config route set|clear|list`
- `/oak-config access grant|revoke|list`

`/oak-config`, `@Oak codex switch`, and restart commands are owner-only.

## Defaults

Oak currently starts Codex with:

- model `gpt-5.5`
- reasoning effort `high`
- service tier `fast`
- approval policy `never`
- sandbox mode `danger-full-access`

That means full filesystem access and no approval prompts.

## Dev

```bash
npm run lint
npm run typecheck
npm run build
npm run check
npm run dry
```

`npm run dry` checks that Oak can connect to the configured app-server without logging into Discord.
