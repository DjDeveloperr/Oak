# Oak Local API

Oak exposes a loopback-only HTTP API from the bot process. It is intended for local automation and for Oak Superagent threads that need to create, steer, compact, or subscribe to other Oak/Codex threads.

Default base URL:

```text
http://127.0.0.1:4788
```

The CLI wrapper is `oak-api` after `npm run build`. During development, run it with:

```bash
node dist/src/oakCli.js <command>
```

## Concepts

- A workspace is Oak's routed workspace config.
- A session is one Discord thread mapped to one Codex thread.
- A Superagent is one long-lived session per workspace. Messages prefixed with `--` in a routed Discord channel are sent to that workspace's Superagent. If it does not exist, Oak creates it.
- The owner can DM Oak directly to use an owner-only admin Superagent rooted at `~/.oak`.
- A subscription asks Oak to notify the workspace Superagent when a target session completes. If the Superagent is working, Oak steers the update into its active turn. Otherwise Oak starts a new Superagent turn with the update.
- A cron job belongs to one Superagent workspace. When it fires, Oak sends the stored message into that same Superagent, steering if the Superagent is already working.

## CLI

List workspaces:

```bash
oak-api workspaces
```

List sessions:

```bash
oak-api sessions
```

Create a new Oak thread and start a Codex turn:

```bash
oak-api thread --workspace <workspace-key> --prompt "Do the task" --name "Optional thread name" --subscribe
```

Use `--subscribe-workspace oak-admin` when an owner DM Superagent dispatches work to another workspace and should receive the completion update itself.

Send a message to an existing Oak session. Oak steers if the session is working, otherwise it starts a new turn:

```bash
oak-api message <discord-thread-id> "Continue with this instruction"
```

Send a message to a workspace Superagent:

```bash
oak-api superagent <workspace-key> "Coordinate this work"
```

The owner-only DM Superagent is addressed as workspace `oak-admin`:

```bash
oak-api superagent oak-admin "List the guilds Oak is in"
```

Schedule a message into a Superagent with a five-field cron expression:

```bash
oak-api cron add --workspace <workspace-key> --expression "0 9 * * 1-5" --message "Review open subscribed work"
oak-api cron add --workspace oak-admin --expression "*/30 * * * *" --message "Check Oak health"
oak-api cron list --workspace <workspace-key>
oak-api cron disable <cron-job-id>
oak-api cron enable <cron-job-id>
oak-api cron remove <cron-job-id>
```

Cron expressions use the bot process timezone and support numbers, `*`, lists, ranges, and steps.

Subscribe the workspace Superagent to a spawned thread:

```bash
oak-api subscribe <workspace-key> --discord-thread <discord-thread-id>
oak-api subscribe <workspace-key> --codex-thread <codex-thread-id>
```

Create a thread and wait for completion:

```bash
oak-api thread --workspace <workspace-key> --prompt "Do the task" --subscribe
oak-api wait <discord-thread-id>
```

Inspect context usage:

```bash
oak-api context <discord-thread-id>
```

Get, set, or clear a Codex app-server goal for a loaded Oak session:

```bash
oak-api goal get <discord-thread-id>
oak-api goal set <discord-thread-id> "Finish the migration" --token-budget 200000
oak-api goal clear <discord-thread-id>
```

Manually compact context:

```bash
oak-api compact <discord-thread-id>
```

Interrupt a running turn:

```bash
oak-api interrupt <discord-thread-id>
```

Fetch the last Oak final answer:

```bash
oak-api last <discord-thread-id>
```

Raw HTTP helpers:

```bash
oak-api get /sessions
oak-api post /sessions/<discord-thread-id>/message '{"message":"hi"}'
```

Admin configuration and Discord helpers:

```bash
oak-api get /config
oak-api post /config/workspaces '{"key":"app","root":"/home/ubuntu/apps/App"}'
oak-api post /config/routes '{"guildId":"123","channelId":"456","workspaceKey":"app"}'
oak-api post /config/access/grant '{"workspaceKey":"app","userId":"789"}'
oak-api get /discord/guilds
oak-api post /discord/script '{"code":"return client.guilds.cache.map(g => ({ id: g.id, name: g.name }));"}'
```

## HTTP Endpoints

`GET /healthz`

Returns API health.

`GET /workspaces`

Returns configured workspaces.

`GET /config`

Returns the full Oak configuration snapshot: workspaces, routes, Superagents, cron jobs, and serialized sessions.

`POST /config/workspaces`

Creates or updates a workspace.

Body:

```json
{ "key": "app", "root": "/home/ubuntu/apps/App" }
```

`POST /config/workspaces/remove`

Removes an unused workspace.

Body:

```json
{ "key": "app" }
```

`POST /config/routes`

Creates or updates a guild or channel route.

Body:

```json
{ "guildId": "123", "channelId": "456 or null", "workspaceKey": "app" }
```

`POST /config/routes/clear`

Clears a guild or channel route.

Body:

```json
{ "guildId": "123", "channelId": "456 or null" }
```

`POST /config/access/grant`

Grants workspace access to a Discord user id.

Body:

```json
{ "workspaceKey": "app", "userId": "789" }
```

`POST /config/access/revoke`

Revokes workspace access from a Discord user id.

Body:

```json
{ "workspaceKey": "app", "userId": "789" }
```

`GET /discord/guilds`

Returns basic guilds visible to the Oak bot.

`POST /discord/script`

Runs owner-intended JavaScript inside the Oak bot process with `client`, `discord`, and `oak` in scope. This is loopback-only and intended for the owner-only DM Superagent.

Body:

```json
{
  "code": "return client.guilds.cache.map(g => ({ id: g.id, name: g.name }));"
}
```

`GET /sessions`

Returns persisted Oak sessions.

`GET /cron-jobs`

Returns persisted Superagent cron jobs. Add `?workspace=<workspace-key>` to filter.

`POST /cron-jobs`

Creates or updates a cron job for a Superagent workspace. `oak-admin` is accepted for the owner-only DM Superagent.

Body:

```json
{
  "id": "Optional stable id; generated when omitted",
  "workspace": "default",
  "expression": "0 9 * * 1-5",
  "message": "Review open subscribed work",
  "enabled": true
}
```

`POST /cron-jobs/enabled`

Enables or disables a cron job.

Body:

```json
{ "id": "cron-job-id", "enabled": false }
```

`POST /cron-jobs/remove`

Removes a cron job.

Body:

```json
{ "id": "cron-job-id" }
```

`POST /threads`

Creates a new Discord thread in a workspace route and creates/resumes the Codex thread for it.

Body:

```json
{
  "workspace": "default",
  "prompt": "Task prompt",
  "name": "Optional Discord thread name",
  "channelId": "Optional routed text channel id",
  "subscribe": "Optional boolean; subscribe the workspace Superagent to completion",
  "subscribeWorkspace": "Optional workspace key whose Superagent receives completion, e.g. oak-admin"
}
```

`GET /sessions/:discordThreadId`

Returns one session.

`POST /sessions/:discordThreadId/message`

Steers the active turn if one is running, otherwise starts a new turn.

Body:

```json
{ "message": "Instruction text" }
```

`GET /sessions/:discordThreadId/last-message`

Returns Oak's last final answer for the session.

`GET /sessions/:discordThreadId/context`

Returns the most recent app-server token usage and the percentage of context used when the model context window is known.

`GET /sessions/:discordThreadId/goal`

Reads the current app-server goal for the session.

`POST /sessions/:discordThreadId/goal`

Sets the current app-server goal for the session.

Body:

```json
{
  "objective": "Finish the migration",
  "tokenBudget": 200000
}
```

`DELETE /sessions/:discordThreadId/goal`

Clears the current app-server goal for the session.

`POST /sessions/:discordThreadId/compact`

Triggers `thread/compact/start` for that Codex thread.

`POST /sessions/:discordThreadId/interrupt`

Sends `turn/interrupt` for the active turn.

`POST /superagents/:workspace/message`

Creates or reuses the workspace Superagent and sends it a message.

Body:

```json
{ "message": "Coordination prompt" }
```

`POST /superagents/:workspace/cron-jobs`

Creates or updates a cron job scoped to the addressed Superagent. This is the preferred endpoint for Superagents scheduling their own work.

Body:

```json
{
  "id": "Optional stable id; generated when omitted",
  "expression": "*/15 * * * *",
  "message": "Scheduled prompt text",
  "enabled": true
}
```

`POST /subscriptions`

Subscribes the workspace Superagent to a session completion. `oak-admin` is accepted for the owner-only DM Superagent.

Body:

```json
{
  "workspace": "default",
  "discordThreadId": "Optional Discord thread id",
  "codexThreadId": "Optional Codex thread id"
}
```

At least one target id is required.

## Superagent Memory

Superagents should maintain durable workspace notes in `OAK_MEMORY.md`. Keep it concise, stable, and actionable. Oak gitignores `OAK_MEMORY.md` in this repo.

## App-Server Notes

Oak uses Codex app-server JSON-RPC over a local WebSocket. Current protocol support in Oak includes:

- `thread/start`
- `thread/resume`
- `thread/read`
- `thread/name/set`
- `thread/archive`
- `thread/compact/start`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `model/list`
- `thread/tokenUsage/updated`
- `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`
- `thread/goal/updated`, `thread/goal/cleared`
- `thread/compacted` and `contextCompaction` item notifications
