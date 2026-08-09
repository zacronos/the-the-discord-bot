# The The Discord Bot — Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted Discord bot (JavaScript) that lets server members start anonymous, privately-voted polls — "invite someone" and "make a channel permanent" — with per-server configurable counting rules, automatic closing, DM'd results, and follow-up actions (single-use invite link / channel move).

**Architecture:** A single long-running Node process using discord.js (gateway). Interactions (buttons, modals, slash commands) drive everything; poll state lives in a local SQLite database; an hourly on-the-hour sweep closes expired polls (expirations are rounded up to the next clock-hour), and an everyone-has-voted close fires immediately.

**Tech Stack:** Node v24.18.0 (installed), discord.js ^14.27.0, `node:sqlite` (built-in) for storage, `node:test` (built-in) for tests. Zero native-build dependencies.

---

## Conventions for executing this plan

- **Checkboxes:** Mark `[X]` as items complete. Keep every nesting level individually in sync: check each sub-item as it lands; only check a parent when *all* children are checked. Never check a parent over unchecked children.
- **Git:** Commit directly to `main` and push. **No PRs, no branches.** Fold plan-checkbox updates into the same commit as the work they track.
- **README:** Documentation for each feature lands **in the same commit** as the feature, including how to invite and configure the bot.
- **`[HUMAN]` steps:** Tagged on the minimal action only. Secrets are passed by **env-var name, never value** — never paste a token into chat or a file the agent reads. Helper scripts write redacted logs to `logs/<ts>__<name>/` (e.g. `logs/2026-08-07T15-30-00__health-check/`); the agent analyzes then **deletes** those folders. `logs/` is gitignored.
- **TDD:** For each unit: write the failing test, run it to see it fail, implement minimally, run to green, commit. Test commands below use `npm test` (`node --test test/`).

## Environment facts (verified 2026-08-07)

- Local folder `C:\Users\Joe\the-the-discord-bot` contains only an empty `logs/` dir; not yet a git repo.
- Remote `github.com/zacronos/the-the-discord-bot` — `main` exists at `8cd2350`, containing `.gitignore`, `LICENSE` (MIT), `README.md` (1 commit).
- `gh` 2.96.0 authenticated as **zacronos** (keyring, `repo` scope, git protocol **ssh**) → push access exists; no credential work expected.
- git identity: Joe Ibershoff `<joe@ibershoff.com>`; node v24.18.0, npm 11.16.0, git 2.54.0.
- discord.js latest is **14.27.0** (requires Node ≥18).
- Discord modals now support **Label + String Select + Channel Select + Text Display** components (verified at docs.discord.com/developers/components/reference) — poll-creation prompts can be a single modal.

## Key design decisions (alternatives & trade-offs)

*All decisions D1–D6 — including D5's TESTING-only minute-sweep deviation — were ratified by the project owner on 2026-08-07. D7 was added the same day as part of the Q9 answer.*

### D1. Gateway bot (chosen) vs HTTP interactions endpoint
Discord's own getting-started guide uses an HTTP endpoint (express + discord-interactions), but that requires a public URL (ngrok/hosting) and *still* needs a persistent process for poll-close timers.

| | Gateway (discord.js) — **chosen** | HTTP interactions endpoint |
|---|---|---|
| Public URL needed | No — outbound websocket only | Yes (ngrok / reverse proxy) |
| Timers / scheduled closes | Natural (process is always up) | Needs a separate scheduler anyway |
| Member counts (privileged intent) | Built-in caching/fetch | Manual REST pagination |
| Serverless-friendly | No | Yes (irrelevant here) |

### D2. Anonymous voting: custom Vote button → ephemeral ballot (chosen)
- **Native Discord polls** — rejected: votes are not anonymous-with-custom-tally; no veto/weights/threshold, no custom close actions.
- **Reactions** — rejected: fully public.
- **Chosen** (same pattern as cdsmith/votebot "Electable"): the public poll message has one **Vote** button; pressing it opens a private *ephemeral* ballot showing your current vote and four choice buttons. Only the bot's DB knows who voted what. This also satisfies "publicly the poll should *only* show initiator/subject/counts/close-time" — the options never appear on the public message.
- *Honesty note (goes in README):* votes are anonymous to Discord users, but whoever runs the bot host can read the SQLite file. True cryptographic anonymity is out of scope.

### D3. Storage: `node:sqlite` (chosen) vs better-sqlite3 vs JSON files
Node 24's built-in `DatabaseSync` = zero dependencies, no Windows native-build risk, real SQL. better-sqlite3 is the drop-in fallback if `node:sqlite` misbehaves (storage is isolated behind `src/db.js`, so swapping is one file). JSON files rejected: concurrent-write corruption risk, no queries.

### D4. Poll-creation prompt: single modal (chosen), ephemeral panel as fallback
Modal contains: **Text Display** (explanation + configured values + urgency warning), per-type input (**Text Input** for invitee name / **Channel Select** for target channel), and a **String Select** for duration (default 7 days). If any modal component turns out unsupported at implementation time, fall back to: button → ephemeral panel with the same selects + a Create button (works on every client, one extra click).

### D5. Scheduler: hourly sweep on the hour (chosen) vs per-poll `setTimeout`
`setTimeout` overflows at ~24.8 days (2³¹ ms) — a 30-day poll breaks it. Instead, a sweep runs **once per hour, on the hour** (first run aligned to the next clock-hour boundary): it closes every poll with `closes_at <= now AND status='open'`, and startup catch-up closes anything that came due while the bot was down. Consequently every poll's expiration is **rounded up to the next clock-hour** (epoch-hour ceiling; a time already exactly on the hour is unchanged), so the displayed close time is always honest. The everyone-has-voted early close stays event-driven (fires on the final vote, not the sweep). `TTDB_TEST_MODE=1` (testing only) sweeps every minute and rounds expirations up to the next minute, so short test polls stay usable.

### D6. Per-server config via `/ttdb-config` slash commands (chosen) vs config file
Slash commands, gated to members with **Manage Server**, keep config in-Discord and per-guild. A config file would require host access for every tweak.

### D7. Auto-start on this machine: Task Scheduler (chosen) vs NSSM service vs pm2
Native Windows Task Scheduler logon-trigger task: no third-party binary (NSSM) or global npm deps (pm2-windows-startup), user-level registration (no admin rights needed), built-in restart-on-failure. Limitation vs a true service: it starts at user logon rather than machine boot — acceptable since this PC runs logged-in, and either way polls only collect votes while the machine is awake (the hourly sweep plus startup catch-up close overdue polls after downtime).

## Difficult spots the spec walks into (and how the plan handles them)

- **"Only show" vs. needing vote controls:** solved by the single Vote button (D2).
- **Fixed option wording** "No, I'd rather not *invite them*…" doesn't fit channel-permanence polls → per-poll-type wording (Q1).
- **"Everyone on the server has voted" + percent threshold** require the member list → **Server Members** privileged intent must be enabled in the Developer Portal (Phase 1 `[HUMAN]` step). `guild.memberCount` alone can't exclude bots.
- **30-day timers** → hourly sweep (D5).
- **Button labels max 80 chars** → the long "No…" wording fits for invites (76 chars); permanence wording must be trimmed (Q1 default).
- **Mention injection:** an invitee name like `@everyone` must never ping — all rendering of user-supplied text uses `allowedMentions: { parse: ['everyone'] }` *only* on the poll content's intentional @everyone, and `parse: []` everywhere else (Phase 3/7).

## Open questions — RESOLVED (answered by project owner 2026-08-07)

- [X] **Q1 — "No" option wording per poll type.** ANSWERED: default accepted. Invite polls use the spec text verbatim; channel-permanence polls use "No, I'd rather not, but I won't object if enough people want to" (fits 80-char button limit).
- [X] **Q2 — Who counts as "everyone"/"people in the server"?** ANSWERED: default accepted — **bots excluded** everywhere; eligible-voter count and percent-threshold base are evaluated **at close time**; votes from members who left before close are dropped.
- [X] **Q3 — Which channel does the single-use invite point at?** ANSWERED: the server's **system channel** by default, with an optional per-server override (`/ttdb-config invite-channel`); final fallback is the poll channel if neither exists. (Verified against API docs 2026-08-07: Discord has no server-level invite endpoint — every invite is created on a channel and admits the member to the whole server, so this choice only affects the post-join landing spot.)
- [X] **Q4 — If a result DM can't be delivered** (user has DMs off): ANSWERED: default accepted — post a minimal, non-revealing notice in the poll channel — "@initiator I couldn't DM you your poll result — enable DMs from server members, then press [Resend result]" (button `ttdb:resend:<pollId>`, usable only by the initiator).
- [X] **Q5 — Data retention after close.** ANSWERED: default accepted — delete all per-user vote rows at close; keep only the poll row (type, subject, initiator, outcome, veto count, timestamps) to support Q4's resend.
- [X] **Q6 — Who may start polls?** ANSWERED: default accepted (any non-bot member who can see the configured poll channel), plus an optional per-server restriction to a single role (`/ttdb-config poll-starter-role`); when set, button presses by members without that role are refused ephemerally. Voting remains open to everyone.
- [X] **Q7 — Concurrent/duplicate polls.** ANSWERED: default accepted — multiple polls may run at once, but starting an *exact* duplicate (same type + same normalized subject, still open) is refused with an ephemeral message.
- [X] **Q8 — Behavior before the server is fully configured.** ANSWERED: no built-in tally defaults; the init message appears only once **all four required settings** have values (`poll-channel`, `hard-no-weight`, `pass-threshold`, `permanent-category` — the optional `invite-channel` / `poll-starter-role` don't gate it). The button-press config check remains as defense-in-depth (e.g., a category deleted after setup), replying ephemerally with the missing `/ttdb-config` steps.
- [X] **Q9 — Where will the bot run long-term?** ANSWERED: on this Windows machine — Phase 8 (per D7) sets up auto-start via Task Scheduler. Caveat stands: polls only collect votes while the machine is awake; time-based closes are caught up at the next hourly sweep or startup.

---

## Phase 0 — Repo checkout & project scaffolding

### 0.1 Establish the git checkout

- [X] `git init -b main` in `C:\Users\Joe\the-the-discord-bot`
- [X] `git remote add origin git@github.com:zacronos/the-the-discord-bot.git` (gh is configured for ssh; if `git ls-remote origin` fails on host-key/agent issues, fall back to `git remote set-url origin https://github.com/zacronos/the-the-discord-bot.git` + `gh auth setup-git`)
- [X] `git fetch origin` then `git reset --hard origin/main` (safe: no local tracked files exist; untracked plan file and `logs/` are preserved) and `git branch --set-upstream-to=origin/main main`
- [X] Review the fetched `README.md` / `.gitignore` / `LICENSE`; extend `.gitignore` with: `node_modules/`, `logs/`, `data/`, `.env` (the fetched Node-template .gitignore already had all but `data/`; README is a bare title line, to be built out in later phases)
- [X] Commit this plan file + .gitignore update — `chore: add implementation plan and ignores` — and `git push` (first push verifies write access; if it's rejected, surface to `[HUMAN]`, but gh auth status makes this unlikely)

### 0.2 Node project scaffolding

- [X] `package.json`: `"type": "module"`, `"engines": { "node": ">=24" }`, scripts: `start` (`node src/index.js`), `test` (`node --test` — note: a `test/` directory argument breaks on Windows, the runner's default `**/*.test.js` discovery is used instead), `register-commands` (`node scripts/register-commands.mjs`), `invite-url` (`node scripts/invite-url.mjs`), `health-check` (`node scripts/health-check.mjs`)
- [X] `npm install discord.js@^14.27.0` (sole runtime dependency)
- [X] `src/env.js`: reads `DISCORD_TOKEN`, `DISCORD_APP_ID`, optional `TTDB_DB_PATH` (default `./data/the-the.sqlite3`), `TTDB_TEST_MODE`, `TTDB_GUILD_ID`; throws a clear error naming any missing required var. Document that humans may use a gitignored `.env` with `node --env-file=.env` (no dotenv dependency needed on Node ≥20.6).
- [X] Smoke test `test/env.test.js` (missing-var error message), run `npm test` to green
- [X] README: add "Development" section (Node ≥24, npm install, npm test, env var **names** and meanings). Commit `chore: scaffold node project` + push

## Phase 1 — Discord application bootstrap (helper scripts shrink the human residue)

### 1.1 Agent: helper scripts + docs first

- [X] `scripts/health-check.mjs`: logs in with `DISCORD_TOKEN` (declaring the Guilds + GuildMembers intents, so a missing SERVER MEMBERS toggle is caught here), prints bot tag, app id, and joined-guild names/ids, then exits. Writes the same **redacted** output (never the token, no member data) to `logs/<ts>__health-check/run.log`. Exit code 1 with a plain-English hint on auth failure.
- [X] `scripts/invite-url.mjs`: no secrets needed — from `DISCORD_APP_ID` prints the install URL with scopes `bot applications.commands` and permissions computed via `PermissionsBitField.resolve([ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory, MentionEveryone, CreateInstantInvite, ManageChannels, ManageRoles])` (ManageChannels+ManageRoles are needed later to move a channel and sync its permission overwrites)
- [X] README: "Creating your Discord application" — numbered portal steps (below) — and "Inviting the bot to a server" using `npm run invite-url`. Commit `feat: app bootstrap scripts and setup docs` + push
- [X] `assets/bot-icon.svg` + rendered `assets/bot-icon-1024.png` — robot-face app icon, added by request 2026-08-07 ("secret-keeper ballot box": visor = anonymous votes, mouth slot = ballot box). Revised same day per owner request: ballot slip removed; eyes are check marks, one green and one red. Rendered headlessly at exactly 1024×1024; upload happens in 1.2.

### 1.2 Human: portal setup and first login

- [X] `[HUMAN]` In https://discord.com/developers/applications → **New Application** (suggested name: "The The Bot") → **Bot** tab → toggle OFF **Public Bot** (restricts installs to the app owner — the install URL is derivable from the public Application ID, so this toggle is the real access control) → toggle ON **SERVER MEMBERS INTENT** (required to know who has/hasn't voted) → **Reset Token** → copy it once. On **General Information**, copy the **Application ID** (and optionally upload `assets/bot-icon-1024.png` as the **App Icon** while on that page). Then in the PowerShell window you'll run the bot from (session-only, value never shown to the agent):
  ```powershell
  $env:DISCORD_TOKEN = '<paste-token-here>'
  $env:DISCORD_APP_ID = '<paste-application-id-here>'
  ```
  (Optional alternative: put the same two lines as `KEY=value` in a gitignored `.env` and run scripts with `node --env-file=.env …`.)
- [X] `[HUMAN]` Run `npm run health-check` in that window
- [X] Agent: read `logs/<ts>__health-check/run.log`, confirm login + intent OK, then **delete** the `logs/<ts>__health-check/` folder (3 runs analyzed 2026-08-07: intents hint worked; final bot user "The The Admin-Polling Bot#2334", app id matches)
- [X] `[HUMAN]` Run `npm run invite-url`, open the printed URL, pick your server, **Authorize** (OAuth grants are human-only; with Public Bot OFF this works only for you, the app owner)

*(Server access control decided 2026-08-07: **Public Bot OFF** is the chosen mechanism. A code-level guild allowlist — auto-leaving unlisted servers — was considered and declined.)*

## Phase 2 — Storage, `/ttdb-config`, and the init message

### 2.1 Database layer (TDD against a temp db file)

- [X] `src/db.js`: opens `node:sqlite` `DatabaseSync` at `TTDB_DB_PATH` (mkdir -p its folder), runs idempotent migrations (implemented as `openDb(path)`; the Phase 2.3 wiring passes `env.dbPath`):
  ```sql
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    poll_channel_id TEXT, init_message_id TEXT,
    hard_no_weight TEXT,            -- '-2'|'-3'|'-5'|'-10'|'veto'
    threshold_type TEXT,            -- 'count'|'percent'
    threshold_value REAL,
    permanent_category_id TEXT,
    invite_channel_id TEXT,         -- optional (Q3); default landing = system channel
    poll_starter_role_id TEXT,      -- optional (Q6); null = anyone may start polls
    updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL, type TEXT NOT NULL,        -- 'invite'|'permanent_channel'
    subject TEXT NOT NULL,                             -- invitee name or channel id
    initiator_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
    created_at INTEGER NOT NULL, closes_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',               -- 'open'|'passed'|'failed'|'vetoed'|'aborted'
    closed_at INTEGER, veto_count INTEGER);
  CREATE TABLE IF NOT EXISTS votes (
    poll_id INTEGER NOT NULL, user_id TEXT NOT NULL,
    choice TEXT NOT NULL,                              -- 'yes'|'no'|'hard_no'|'abstain'
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (poll_id, user_id));
  ```
- [X] `src/store/guildConfig.js` (`getConfig(guildId)`, `setConfig(guildId, patch)`), `src/store/polls.js` (`createPoll`, `getPoll`, `setMessageId`, `listDue(now)`, `listOpen(guildId)`, `closePoll(id, status, vetoCount)`), `src/store/votes.js` (`castVote(pollId, userId, choice)` upsert, `getVote`, `countByChoice(pollId)`, `countVoters(pollId)`, `deleteVotes(pollId)`) — all store functions take the open db handle as their first argument; `votes.js` also exports `CHOICES`
- [X] Tests first for each store module (`test/store/*.test.js`, temp db per test); run red → implement → green
- [X] Commit `feat: sqlite storage layer` + push

### 2.2 `/ttdb-config` slash commands

- [X] `src/features/configCommands.js` — one `/ttdb-config` command (default member permissions: **Manage Server**; guild-only) with subcommands:
  - `poll-channel channel:<text channel>` — warns ephemerally if the bot lacks any of: View Channel, Send Messages, Embed Links, Mention Everyone, Read Message History in that channel
  - `hard-no-weight weight:<choice of -2 | -3 | -5 | -10 | veto>`
  - `pass-threshold value:<number ≥ 0> unit:<choice of votes | percent>`
  - `permanent-category category:<category channel>` — warns if bot lacks Manage Channels / Manage Roles
  - `invite-channel channel:<text channel>` — *optional* (Q3): where invite links from passed polls land; unset = the server's system channel; warns if the bot lacks Create Instant Invite there
  - `poll-starter-role role:<role>` — *optional* (Q6): when set, only members with this role may start polls (voting stays open to everyone)
  - `show` — ephemeral display of all current settings, flagging any required ones still missing
  - After any successful change: if all four **required** settings (`poll-channel`, `hard-no-weight`, `pass-threshold`, `permanent-category`) now have values, run init-message ensure (2.3) — per Q8 the init message only exists once required config is complete
- [X] Tests for the validation/formatting logic (command *handlers* as pure functions taking a fake interaction; no live Discord)
- [X] `scripts/register-commands.mjs`: registers the command definitions via REST; guild-scoped to `TTDB_GUILD_ID` when set (instant), global otherwise (~1 h propagation). Redacted run log to `logs/<ts>__register-commands/run.log`. (Shared redacted-log helper extracted to `scripts/script-log.mjs`; health-check refactored onto it.)
- [X] README: "Configuring the bot" — every subcommand, what it controls, and that polls refuse to start until required settings exist (Q8 default). Commit `feat: per-server configuration commands` + push
- [X] `[HUMAN]` In the env-var PowerShell window: `$env:TTDB_GUILD_ID = '<your-server-id>'` (right-click server icon → Copy Server ID, with Developer Mode on) then `npm run register-commands`
- [X] Agent: verify + delete `logs/<ts>__register-commands/` (verified 2026-08-07: `/ttdb-config` registered guild-scoped OK. The run then crashed at exit with a Windows libuv assertion — harmless to the registration; scripts fixed to exit naturally via `process.exitCode` + undici agent close instead of `process.exit()`.)

### 2.3 Init message with feature buttons

- [X] `src/features/initMessage.js` — `ensureInitMessage(guild)`: embed (footer marker `ttdb-init-v1`) explaining the two features, with buttons `ttdb:start:invite` ("Start a vote on inviting someone") and `ttdb:start:permchan` ("Start a vote on making a channel permanent"). Dedupe order: (1) stored `init_message_id` still exists → done; (2) scan last 100 channel messages for a bot-authored `ttdb-init-v1` footer → adopt it; (3) otherwise post fresh and store the id. When `poll-channel` changes, best-effort delete the old init message, then ensure in the new channel. Runs on startup for every guild whose four required settings are complete, and after any config change that leaves them complete (Q8); while required config is incomplete no init message is posted.
- [X] Tests: dedupe decision logic with a mocked channel (exists / adoptable / absent; channel-change path)
- [X] `src/index.js` + `src/discord/client.js`: client with intents `Guilds`, `GuildMembers`; `src/discord/interactionRouter.js` dispatches by `customId` prefix (`ttdb:`) and command name; `src/discord/customId.js` — `build(...parts)` / `parse(id)` helpers (tested). (Tracking the init message's channel needed a `guild_config.init_channel_id` column — added to the schema with a guarded ALTER for older files.)
- [X] README: "How the poll channel works" (init message, buttons, what happens if it's deleted — reposted on next startup/config change). Commit `feat: init message and interaction routing` + push

## Phase 3 — Poll creation & anonymous voting framework

### 3.1 Creation modal

- [X] `src/features/pollCreate.js` — on `ttdb:start:*`: check the Q6 starter-role gate (if `poll_starter_role_id` is set and the presser lacks that role → ephemeral refusal), the Q8 config gate (defense-in-depth — ephemeral list of missing settings; normally unreachable since the init message only appears once required config is complete), and the Q7 duplicate gate, else open modal `ttdb:create:<type>`:
  - **Text Display**: "This starts an anonymous poll in this channel, open to everyone on the server. Nobody can see how anyone voted. The poll closes after the duration you pick, rounded up to the next hour on the clock — or as soon as everyone on the server has voted. When it closes, results are tallied (current settings: a **Hard no** counts as `<hard-no-weight>`; passing requires `<threshold: N votes | N% of members>`) and the outcome is DM'd to you. ⚠️ A shorter poll may reach a result quicker, but leaves less time for everyone to see it and vote — avoid shorter durations unless there is a real reason for urgency."
  - Invite type: **Text Input** `name` (label "Who should we invite?", max 80 chars)
  - Permanence type: **Channel Select** `channel` (text channels only)
  - Both: **String Select** `duration` — options 3/5/7/14/30 days (7 = default-selected); with `TTDB_TEST_MODE=1`, extra options "5 minutes (TESTING ONLY)" / "30 minutes (TESTING ONLY)"
  - Fallback if any modal component is rejected at runtime: D4's ephemeral-panel flow
- [X] Tests: modal/duration builders (default marked, test-mode additions), config-gate + starter-role-gate + duplicate-gate logic. (Deviation: the Q7 duplicate gate runs at modal *submit*, not button press — the subject isn't known until then.)

### 3.2 Poll message

- [X] On modal submit: validate subject (name trimmed, 1–80 chars; channel is a text channel not already in the permanent category), compute `closes_at = roundUpToNextHour(created_at + duration)` (`src/util/time.js`; epoch-hour ceiling, exact-hour values unchanged; with `TTDB_TEST_MODE=1` round up to the next minute instead), insert poll row, post to the poll channel: content `@everyone` with `allowedMentions: { parse: ['everyone'] }`, embed showing **only**: who initiated, what the poll is about ("Should we invite **{name}** to the server?" / "Should {#channel} be made permanent?"), responded count, not-yet-responded count, closes `<t:…:R>` — plus one **Vote / change my vote** button (`ttdb:vote:<pollId>`). Store `message_id`. Reply ephemerally to the initiator with a link to the poll.
- [X] Eligible-voter helper `src/features/eligibility.js`: fetch members, count non-bots (per Q2), cache 60 s per guild
- [X] Tests: embed renderer (pure: poll row + counts → embed fields), subject sanitation (a name of `@everyone`/`<@123>` renders inert), `roundUpToNextHour` (mid-hour rounds up; exact hour unchanged; test-mode minute rounding)

### 3.3 Ephemeral ballot

- [X] `src/features/ballot.js` — `ttdb:vote:<pollId>`: ephemeral reply showing "Your current vote: **X**" (or "You haven't voted yet") + four buttons `ttdb:cast:<pollId>:<choice>` labeled per Q1 wording ("Yes!" / "No, I'd rather not invite them, but I won't object if enough people want to" / "Hard no, I really don't want this" / "I abstain from voting"); votes may be changed until close; casting updates the ephemeral message in place and refreshes the public counts (throttled: at most one embed edit per poll per 5 s)
- [X] Closed/unknown poll → ephemeral "this poll has closed"
- [X] After every cast: if `countVoters(pollId) >= eligibleCount`, trigger the close pipeline immediately (everyone-voted early close)
- [X] Tests: cast/change/upsert flows, throttle logic, early-close trigger condition
- [X] README: "Starting a poll" + "Voting and privacy" (what's public, what's private, changing your vote, early close). Commit `feat: poll creation and anonymous voting` + push

## Phase 4 — Closing engine

### 4.1 Tally (pure function, exhaustive tests first)

- [X] `src/polls/tally.js`:
  ```js
  // tallyPoll({ counts, hardNoWeight, threshold, eligibleCount })
  //   counts: { yes, no, hard_no, abstain }   hardNoWeight: '-2'|'-3'|'-5'|'-10'|'veto'
  //   threshold: { type: 'count'|'percent', value: number }
  //   returns { outcome: 'passed'|'failed'|'vetoed', vetoCount, total, target }
  ```
  yes=+1, abstain=0, no=−1, hard_no=configured weight; any hard_no under `'veto'` ⇒ vetoed; else passed iff `total >= target` where target = `value` (count) or `(value/100) * eligibleCount` (percent)
- [X] Test table: single veto overrides big yes majority; each numeric weight; exact-boundary equality passes (both units); percent scales with eligibleCount; all-abstain vs `value: 0` passes; empty poll fails any positive threshold
- [X] Commit `feat: vote tally rules` + push

### 4.2 Scheduler & close pipeline

- [X] `src/features/scheduler.js`: sweep **once per hour, on the hour** (`setTimeout` aligned to the next clock-hour boundary, then hourly; `TTDB_TEST_MODE=1` sweeps every minute) — each sweep closes polls with `closes_at <= now` (D5) and refreshes open-poll embed counts (membership may have changed); on startup — immediately close any polls that came due while the bot was down
- [X] `src/features/pollClose.js` — atomic claim (`UPDATE polls SET status='closing' WHERE id=? AND status='open'`, skip if no row changed), then: drop votes from users no longer in the guild (Q2) → tally → DMs → on `passed` run the poll-type action (Phases 5/6) → delete the poll message (ignore already-deleted) → persist final status + veto_count → apply Q5 retention (delete vote rows)
- [X] DM texts (send sequentially, ~500 ms apart; Q4 fallback on failure):
  - vetoed → initiator: "Your poll "<subject>" was vetoed by <N> member(s), so it did not pass. Please refrain from starting this poll again unless community concerns can be alleviated through private conversation."
  - vetoed → each vetoer: "The poll "<subject>" failed because of your veto. It may be helpful to privately discuss your concerns with <initiator>, who started it."
  - failed → initiator (no numbers): "Your poll "<subject>" did not pass. Please refrain from starting it again unless community concerns can be alleviated."
  - passed → initiator: "Your poll "<subject>" passed!" + action-specific content (Phases 5/6)
- [X] Abort path: poll message or channel found deleted while open → status `aborted`, DM initiator a brief explanation
- [X] Tests: due-selection, idempotent claim (double-close is a no-op), DM ordering/recipients per outcome (mocked transport), retention applied
- [X] README: "How results are decided" (weights, veto, both threshold units with worked examples, close conditions, poll deletion, what the initiator does/doesn't learn). Commit `feat: poll closing engine` + push

## Phase 5 — "Invite someone" success action

- [X] `src/features/actions/invite.js`: on pass, create invite on the Q3 landing channel (configured `invite-channel` → server system channel → poll channel) — `createInvite({ maxUses: 1, maxAge: 604800, unique: true, reason: 'Poll <id> passed' })` — and include the URL in the initiator's success DM: "Here is a single-use invite link, valid for 7 days, to send to <name>: <url>"
- [X] Missing Create Instant Invite permission → still DM success, but explain the bot couldn't create the link and an admin should (handled by the pipeline's action-failure note, tested in 4.2)
- [X] Tests: invite options, permission-failure path (mocked channel)
- [X] README: feature walkthrough under "Poll types". Commit `feat: invite-someone poll action` + push

## Phase 6 — "Make channel permanent" success action

- [X] `src/features/actions/permanentChannel.js`: on pass — verify configured category still exists, then `channel.setParent(categoryId, { lockPermissions: true, reason: 'Poll <id> passed' })` (moves the channel *and* syncs its permission overwrites with the category, per spec)
- [X] Failure paths (category deleted, missing Manage Channels/Manage Roles, channel deleted mid-poll) → success DM still sent with a clear "action needs an admin" note + log (via the pipeline's action-failure note, tested in 4.2)
- [X] Creation-time guard recap (from 3.2): only text channels, not already in the permanent category
- [X] Tests: setParent args include `lockPermissions: true`; each failure path
- [X] README: feature walkthrough. Commit `feat: permanent-channel poll action` + push

## Phase 7 — Hardening, polish, final docs

- [X] Global interaction error handler: ephemeral "Something went wrong — the details were logged." + console log; process-level `unhandledRejection` logging (built with the router in 2.3; unhandledRejection logging in index.js)
- [X] Startup permission audit per configured guild: log any missing channel/category permissions in one readable block
- [X] Guild-leave cleanup: open polls in that guild → `aborted`
- [X] Input hygiene sweep: every render of user-supplied text (names) uses `allowedMentions: { parse: [] }` or embed-only placement; name length limits enforced server-side; control/zero-width characters stripped
- [X] Final README pass: intro, feature list, invite+configure quick-start (top of file), self-hosting guide (env var names, `npm start`, data file location/backup), privacy notes (D2 honesty note), troubleshooting (missing intent, missing permissions, commands not appearing)
- [X] Delete any remaining analyzed `logs/<ts>__*` folders (verified empty)
- [X] Final `npm test` green; commit `chore: hardening and final docs` + push; verify remote `main` matches local (`git status` clean, `git log origin/main..main` empty)

## Phase 8 — Auto-start on this machine (Q9 / D7)

- [X] `scripts/start-bot.cmd` — Task Scheduler launcher: `cd` to the repo root, rotate the previous log (`move /Y data\bot.log data\bot.log.1`), then `node --env-file=.env src/index.js >> data\bot.log 2>&1`. Bot console output contains no secrets (the token is never logged), and `data/` is gitignored.
- [X] `[HUMAN]` Create `.env` in the repo root (gitignored; read only by the launcher — the agent never sees the values; no-op if already created during Phase 1's optional alternative). Exactly two lines:
  ```
  DISCORD_TOKEN=<paste-token-here>
  DISCORD_APP_ID=<paste-application-id-here>
  ```
- [X] `scripts/install-startup-task.ps1` (+ matching `scripts/uninstall-startup-task.ps1`) — idempotent `Register-ScheduledTask` for task **"TheTheDiscordBot"**: trigger *At log on* of the current user, action = `start-bot.cmd`, settings: on failure restart every 1 minute up to 3 times, no execution time limit, allow start on batteries. User-level registration — no admin rights needed; re-running replaces the task.
- [X] Run the install script, then `Start-ScheduledTask -TaskName TheTheDiscordBot`; confirm the task state is Running and `data/bot.log` shows a successful login line (verified 2026-08-07: task Running; log shows "logged in as The The Admin-Polling Bot#2334; 1 guild(s)")
- [X] README: "Running on startup (Windows)" — install/uninstall/start/stop commands, log location, the sleep caveat (votes are only collected while the machine is awake; the hourly sweep catches up missed closes at the next run or startup)
- [X] Commit `feat: auto-start via Windows Task Scheduler` + push

## Post-Automation (human, after the agent's automatable work — no checkboxes)

- Live end-to-end pass on a real (or throwaway) server with `TTDB_TEST_MODE=1`: configure the four required settings (plus the optional `invite-channel` / `poll-starter-role` if desired); run an invite poll and a permanence poll with 5-minute durations (test mode sweeps every minute; production sweeps hourly on the hour); vote from 2+ accounts; exercise a veto outcome, a failed outcome, and both pass actions (invite link redeems once; channel moves + perms sync); confirm DMs, vote-change, early close when everyone votes, and poll-message deletion.
- After Phase 8: reboot the machine once and confirm the scheduled task auto-starts the bot (task shows Running; a fresh login line appears in `data/bot.log`). Hosting is settled (Q9: this machine); the startup catch-up (4.2) closes overdue polls after any downtime, but votes can only be cast while the machine is awake.
- Rotate the bot token immediately if it's ever pasted anywhere public; re-run the Phase 1 env-var step and update `.env` after rotating.
- Occasionally back up `data/the-the.sqlite3` (stop the bot first, copy the file).

## Post-plan change log

- [X] 2026-08-09 (owner request, assessment item 4): every poll message carries a "Pass rules" field — vote weights (from `hardNoDescription`) plus the threshold that applies to *this* poll, resolved by the same channel-aware logic the close pipeline uses (extracted to `src/polls/threshold.js`). Refreshes re-render it, so mid-poll config changes are visible on the message instead of silent.

- [X] 2026-08-09 (owner request, assessment gap 1): the configured poll channel and invite channel are excluded from deletion nominations (dropdown and submit validation) — the bot must not be voted into deleting its own operating surface.

- [X] 2026-08-09 (owner request, assessment gap 2): deletion-lifecycle guards. A passed permanence poll cancels the channel's pending scheduled deletion (noted in the result DM), and the deletion sweep re-checks at execution time — a channel inside any permanent group is spared and its schedule dropped. Decided **against** refusing concurrent cross-type polls on one channel (owner): a perpetually renewed permanence poll could otherwise filibuster deletion votes.

- [X] 2026-08-09 (owner request, assessment gap 6): documented (README, channel-protection section) that a locked channel moved into an `other-permanent-groups` category keeps its creator-lock overwrites — the bot stops touching such channels entirely and never cleans them up; removal is manual. Decision: document the asymmetry rather than auto-clean on transition.

- [X] 2026-08-09 (owner request, assessment gap 5): `/ttdb-config permanent-category` now warns when the chosen category is hidden from `@everyone` — the category sync is what delivers the "permanence makes a channel public" promise, so a private category would quietly break it. Warning only; the setting still saves.

- [X] 2026-08-09 (owner request): `/ttdb-set-creator channel member` (guild-only, visible to everyone — authorization in the handler: the recorded creator, or Manage Server, which also fixes unknown/unrecorded creators). Target must be a non-bot member who can see the channel; a no-op handover is reported as such. Updates `known_channels` and re-runs the lock enforcement, so the new creator gains the Manage Channels grant and the old creator's is stripped as a foreign allow; an unrecorded channel gets recorded and locked. Channels in the managed permanent categories or other permanent groups are refused — no permission changes there.

- [X] 2026-08-09 (owner request): `/ttdb-deletions` (Manage Server, guild-only) — `list` shows this server's pending scheduled deletions (channel, `<t:…:F>`/`<t:…:R>` time, originating poll); `cancel channel:<…>` removes the schedule and posts an in-channel notice naming the canceler (mention rendered, never pinged). Cancel verifies the row belongs to the invoking guild; a failed notice never blocks the cancel. New store helpers `listScheduledDeletions`/`getScheduledDeletion`.

- [X] 2026-08-09 (owner request): private→permanent acknowledgement flow. Nominating a private channel for permanence no longer opens the poll directly: the initiator gets an ephemeral warning that passing will make the channel **public**, with an acknowledgement button (channel + duration ride in the `pubok` customId; everything is re-validated on press, and the warning morphs in place into the live-poll confirmation). The poll message itself warns voters the channel will become public. On pass, the action lifts the `@everyone` ViewChannel deny *before* the move + category sync, so going public never depends on what the category's overwrites happen to be.

- [X] 2026-08-09 (owner request): regression tests pinning the promotion permission story — the category sync (`lockPermissions: true`) replaces the channel's overwrites, which strips the creator-only deletion lock, and the registry's daily sweep never re-adds a creator grant to a permanent-category channel. No behavior change; the invariant can no longer regress silently.

- [X] 2026-08-09 (owner request): the channel-deletion pass threshold split in two. The pre-split `threshold_*_delchan` columns keep their meaning but now apply only to channels inside the managed permanent categories; new `threshold_*_delchan_other` columns cover every other channel (new `poll-type:channel-deletion-other` scope; `all` sets both; the legacy shared threshold still falls back for both kinds). The deletion dropdown offers only channels whose kind has a resolved threshold, submit validation mirrors it, and the applicable threshold is resolved **at close time** from the channel's then-current category (vanished channel → other). `thresholdFor` now throws for `delete_channel` (use `deletionThresholdFor`); the init message and `show` list both bars.

- [X] 2026-08-09 (owner request): the init message is kept pinned — every `ensureInitMessage` scan (startup, config change, adoption after db loss, fresh post) pins the message when it isn't already. Best-effort: a pin failure (e.g. a full pin list) logs a warning without breaking the scan, and an already-pinned message is never re-pinned (no repeat system notices).

- [X] 2026-08-09 (owner request): channel registry + creator-only deletion locks. New `known_channels` table; the `ChannelCreate` gateway event records new text/voice channels with their audit-log creator (short retry for audit-log lag), and a startup scan backfills unrecorded visible channels via a paginated audit-log backscan (creator recorded as unknown once retention has expired). `other-permanent-groups` channels are never tracked. Recorded channels outside the managed permanent categories are locked to creator-only deletion — @everyone gets a Manage Channels deny, the creator (while still a member) an allow, and foreign Manage Channels allows are cleared; administrators bypass overwrites by design, and Discord couples channel *editing* with deletion in the same permission bit. A daily sweep (hourly in test mode; stamped in `app_state`) re-aligns drifted permissions and forgets vanished channels; `ChannelDelete` forgets immediately. Depends on the Administrator install (View Audit Log + overwrite editing everywhere).

- [X] 2026-08-09 (owner request): deletion polls widened from permanent-category channels to **any text/voice channel the initiator can see**, except channels inside `other-permanent-groups` categories (still protected). Submit-side validation mirrors the dropdown, and forged submissions naming a non-text/voice channel (e.g. a category) are refused. Visibility filtering and the 25-option cap unchanged.

- [X] 2026-08-09 (owner request): the install URL now requests server-wide **Administrator** instead of the granular eight-permission set (supersedes the 1.1 `invite-url.mjs` permission computation). Rationale: private-channel polls need the bot inside every private channel, and Administrator is the one grant channel overwrites can't take away; it subsumes the old set. `scripts/invite-url.mjs` and the README's invite section updated. The startup audit and config-time warnings keep their granular checks — they pass trivially under Administrator and still catch installs invited under the old URL.

- [X] 2026-08-08 (owner request): private-channel handling for channel polls. A channel hidden from `@everyone` gets its poll posted inside itself (voice channels use their built-in text chat — same channel id), so the name never leaks; `polls.is_private` is stamped at creation. Population semantics follow: percent thresholds scale to the channel's viewers, literal thresholds are capped at the viewer count, everyone-has-voted early close counts viewers, closes defer when the viewer count is unknowable, and non-viewers' forged ballot interactions are refused. Creation fails cleanly (with poll cleanup) when the bot itself can't post in the private channel.

- [X] 2026-08-08 (owner request): both bot-built channel dropdowns (deletion and permanence) filter to channels the initiating member can see, restoring the per-user visibility Discord's native channel select provided; forged submissions naming an invisible channel are refused at submit as well.

- [X] 2026-08-08 (owner request): new multi-value `other-permanent-groups` config (add/remove one category per invocation; JSON list column). Channels in these groups are protected: excluded from permanence nominations and never offered for deletion. The permanence poll's channel picker became a bot-built string select (like deletion's) listing only channels outside every permanent group; submit-side validation broadened to match.

- [X] 2026-08-08 (owner request): the deletion poll's channel dropdown now shows only channels from the configured permanent categories. Discord's ChannelSelect can't filter by category, so it became a bot-built string select (options enumerated at button-press time, `#`/🔊 labels, 25-option cap, empty-category refusal); submit-side category validation retained as defense-in-depth.

- [X] 2026-08-08 (owner request): the shared member snapshot's TTL was raised from 10 minutes to 1 hour, and the snapshot (member ids + bot flags + eligible count) is persisted in a new `member_cache` sqlite table with its expiration timestamp, so restarts no longer re-spend the rate-limited REQUEST_GUILD_MEMBERS budget.

- [X] 2026-08-08 (owner request): black-box test-gap review (subagent read README + tests only) yielded 15 new tests; two real defects surfaced and were fixed — ballots now reject interactions from a different guild, and the README's worked example arithmetic was corrected.
- [X] 2026-08-08 (owner request): third poll type — **channel deletion**. Own threshold (`pass-threshold poll-type:channel-deletion`; `all` covers every type; disabled until a threshold resolves), nominees restricted to channels inside the configured permanent categories, and on pass the channel is scheduled for deletion at now+24 h rounded up to the wall-clock hour (test mode: +5 min, minute-rounded), announced in the channel with the exact day/time via a new `scheduled_deletions` table; the hourly sweep (which also runs at startup, covering offline gaps) performs the deletion.

- [X] 2026-08-08 (owner request): "point total / points total" terminology swept through the README; the init message's point-totaling paragraph became a bullet list; new `/ttdb-config max-open-polls` setting (integer 1–100, default 10 when unset) caps simultaneous open polls per server, enforced at poll creation. Slash commands re-registered for the new subcommand.

- [X] 2026-08-08 (owner request): the init message gained a second paragraph explaining how votes are totaled as points (reflecting the configured hard-no weight) and a closing bullet list of the current per-poll-type pass thresholds. Both are config-derived and covered by the content hash, so changing `hard-no-weight` or `pass-threshold` edits the message in place through the existing self-update mechanism.

- [X] 2026-08-08 (owner request): per-poll-type pass thresholds (`pass-threshold` gains optional `poll-type: invite | channel-permanence | both`, default both) and per-channel-kind permanent categories (`permanent-category` gains optional `kind: text | voice`, default text; permanence polls now accept voice channels, autodetecting the category by channel kind). Six new nullable columns with guarded migrations; resolution falls back to the legacy shared columns so existing configs stay valid; voice has no fallback — nominations are refused until a voice category is set. Slash commands re-registered.

- [X] 2026-08-08 (owner request): the gitignored `.env` file is now the canonical (and only documented) way to supply configuration — README no longer mentions session `$env:` values, and all secret-consuming npm scripts load it via `node --env-file-if-exists=.env` so the instructions hold up. Error/hint texts point at `.env`.
- [X] 2026-08-08 (owner request): the bot syncs its own profile at startup and on config changes via `PATCH /applications/@me`. Description: "admins: use /ttdb-config to set up The The Admin-Polling Bot" until fully configured, then "Go to the #<poll-channel> channel to start a vote! (admins: use `/ttdb-config` to configure voting rules)" (channel by literal #name — About Me doesn't render mention tokens; first fully-configured guild wins, single-server bot). App icon pushed from `assets/bot-icon-1024.png`, gated by a content hash stored in the new `app_state` table.
- [X] 2026-08-08 (owner request): the init message self-updates. On startup/config-change, a fully-configured guild's found init message is compared against the current code's version via a content hash in the footer (`ttdb-init-v1 <hash>`); mismatches are edited in place, absence still triggers a fresh post. Legacy plain-marker messages are recognized by prefix and upgraded.

## References

- Discord getting-started (starting point per spec): https://docs.discord.com/developers/quick-start/getting-started — note it demos the HTTP-endpoint style; D1 explains why this bot uses the gateway instead
- Components reference (modal capabilities verified 2026-08-07): https://docs.discord.com/developers/components/reference
- discord.js v14 guide: https://discordjs.guide
- Prior art for private ballots (per spec): https://github.com/cdsmith/votebot — "Electable" (Python); its Vote-button → ephemeral-ballot pattern is what D2 adopts
