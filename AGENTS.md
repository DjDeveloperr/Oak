# AGENTS

This repository is a self-hosted Discord bot that supervises a local `codex app-server` and maps Discord threads to Codex threads. Future agents should treat the app-server protocol and session persistence as the main integration surfaces.

## Working Rules

- Keep changes small and pragmatic. This codebase is operational infrastructure, not a framework exercise.
- Validate behavior with `npm run lint`, `npm run typecheck`, and `npm run build`.
- Prefer editing the real source of truth over adding new wrappers.
- Avoid hardcoding machine-specific paths, guild IDs, channel IDs, or user IDs.

## Repository Layout

- `src/index.ts`
  - Supervisor process. Starts the Discord bot and `codex app-server`, restarts children on failure, and handles restart requests from the bot.
- `src/bot.ts`
  - Main Discord integration. Handles message routing, thread creation, session lifecycle, thread preference UI, restarts, interrupts, and slash commands.
- `src/codexClient.ts`
  - WebSocket client for the Codex app-server.
- `src/threadPreferences.ts`
  - Model, reasoning, fast-mode, and service-tier option normalization plus Discord component builders.
- `src/accessConfig.ts`
  - Persistent workspace and routing config.
- `src/sessionStore.ts`
  - Persistent Discord thread to Codex thread session state.
- `src/codexSwitch.ts`
  - Optional local helper for switching between Codex profiles in `~/.codex-profiles`.
- `src/rateLimitChecker.ts`
  - Reads rate limits by spawning isolated `codex app-server` processes under discovered local Codex profiles.

## Runtime State

- `.runtime/config.json`
  - Persisted workspace, route, and access config.
- `.runtime/sessions.json`
  - Persisted session records keyed by Discord thread ID.
- `.runtime/attachments/`
  - Saved message attachments forwarded to Codex.

There is a compatibility fallback to `oak/.runtime/`, but new setups should use `.runtime/`.

## Important Invariants

- One Discord thread corresponds to one Codex thread in persisted session state.
- `turn/interrupt` must include both `threadId` and `turnId`. Do not send interrupts without a resolved active turn ID.
- `model/list` is the preferred source of truth for model metadata. `src/threadPreferences.ts` contains a static fallback only for degraded operation.
- The app-server initialize payload opts out of notifications Oak does not use. Keep that list aligned with the actual event handlers in `src/codexClient.ts`.
- Access control is enforced through routed workspaces. Messages from unrouted locations should not create or continue sessions.
- Default execution mode is intentionally permissive right now: approval policy `never` and sandbox `danger-full-access`.

## Setup Notes

- Environment variables are loaded from `.env` in the current working directory and repo root.
- Bootstrap workspace routing comes from `OAK_BOOTSTRAP_*` variables and is only used when `.runtime/config.json` does not exist yet.
- The default WebSocket address is `ws://127.0.0.1:4789`.

## When Changing App-Server Behavior

- Check the official docs first: https://developers.openai.com/codex/app-server
- If you have the matching local Codex CLI available, verify against the generated schema or by smoke-testing a live `codex app-server`.
- Preserve protocol compatibility before trying to redesign the client surface.

## Release Hygiene

- Keep `.env`, `.runtime/`, and local Codex profile data out of version control.
- Favor generic naming in package metadata, client info, and user-facing docs.
- Document any new environment variables in both `README.md` and `.env.example`.
