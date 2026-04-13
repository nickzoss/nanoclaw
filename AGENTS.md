# AGENTS.md

## Start here
- Read `README.md`, `CLAUDE.md`, `docs/REQUIREMENTS.md`, and `CONTRIBUTING.md` before broad changes.
- This repo keeps core minimal: accepted core changes are bug fixes, security fixes, and simplifications. New capabilities usually belong in skills, not `src/`.
- Channel integrations are intentionally skill-added. On `main`, `src/channels/index.ts` is mostly side-effect import placeholders.

## Architecture snapshot
- `src/index.ts` is the orchestrator: it loads channel modules, polls SQLite for new messages, groups work by chat JID, streams agent output back to channels, and starts the scheduler + IPC watcher.
- Channels self-register through `src/channels/registry.ts`. A channel module should call `registerChannel(...)`; its factory should return `null` when credentials are missing so startup can skip it cleanly.
- Persistence lives in `src/db.ts`: SQLite stores chats, messages, router state, sessions, registered groups, and scheduled tasks. Chat metadata is stored broadly; message content is what drives prompt reconstruction.
- Message prompts are built in `src/router.ts` as XML-like `<messages>` payloads. Outbound text strips `<internal>...</internal>` blocks; preserve that contract when touching agent I/O.
- `src/group-queue.ts` enforces per-group serialization with a global concurrency cap. Message containers can stay alive for follow-up IPC input; task containers are queued through the same group gate.
- `src/task-scheduler.ts` polls due tasks, then runs them in the owning group context. `context_mode: 'group'` reuses that group’s Claude session; `'isolated'` starts fresh.
- `src/ipc.ts` is filesystem-based IPC under `data/ipc/<group>/`. Authorization comes from the source folder namespace, not from trusting JSON payload fields.

## Container and security model
- `src/container-runner.ts` is the main sandbox boundary. Non-main groups get writable `groups/<folder>` plus read-only `groups/global/`; main gets project root read-only plus writable `store/`, its own group folder, and writable `groups/global/`.
- Each group also gets isolated runtime state in `data/sessions/<group>/.claude` and its own copied `container/agent-runner/src` tree, so agent customization is group-local.
- Container skills in `container/skills/*` are copied into each group’s `.claude/skills/` at startup; keep them small because they share context budget.
- Secrets are not mounted into containers. `OneCLI` config is applied in `src/container-runner.ts`, and `.env` is explicitly shadowed for main.
- Additional mounts must go through `validateAdditionalMounts()` in `src/mount-security.ts`; the allowlist lives outside the repo at `~/.config/nanoclaw/mount-allowlist.json`.
- Preserve group-folder safety checks by using helpers from `src/group-folder.ts` rather than hand-building group or IPC paths.

## Repo-specific behavior to preserve
- Non-main groups usually require a trigger (`group.requiresTrigger !== false`); non-trigger messages accumulate in SQLite and are included when a later trigger arrives. This logic exists in both `startMessageLoop()` and `processGroupMessages()` in `src/index.ts`.
- Main vs non-main is a real privilege boundary: only main can refresh/register groups via IPC, see all available groups, manage all tasks, and write shared global memory.
- Registering a group should never overwrite an existing `groups/<folder>/CLAUDE.md`. The runtime copies templates once from `groups/main/CLAUDE.md` or `groups/global/CLAUDE.md`, then leaves user edits alone.
- If you add a new channel via a skill, update the self-registration import barrel and follow the existing startup contract: installed-but-unconfigured channels should warn and skip, not crash startup.

## Build, test, debug
- Build/run: `npm run build`, `npm run dev`, `npm start`.
- Tests: `npm test` runs `src/**/*.test.ts` and `setup/**/*.test.ts`; skill tests use `npx vitest --config vitest.skills.config.ts`.
- Setup steps are subcommands of `setup/index.ts`; for example `npx tsx setup/index.ts --step verify` runs the end-to-end verifier used by setup flows.
- Service installation/build behavior lives in `setup/service.ts` (launchd, systemd, or nohup fallback depending on platform/session).
- For container failures, inspect `groups/<group>/logs/container-*.log`. Set `LOG_LEVEL=debug` to include container args and full mount details.
- Rebuild the agent image with `./container/build.sh`. If container changes appear stale, prune the builder cache before rebuilding; the repo docs note that BuildKit can keep old `COPY` results even with `--no-cache`.

