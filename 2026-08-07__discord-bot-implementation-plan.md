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
`setTimeout` overflows at ~24.8 days (2³¹ ms) — a 30-day poll breaks it. Instead, a sweep runs **once per hour, on the hour** (first run aligned to the next clock-hour boundary): it closes every poll with `closes_at <= now AND status='open'`, and startup catch-up closes anything that came due while the bot was down. Consequently every poll's expiration is **rounded up to the next clock-hour** (epoch-hour ceiling; a time already exactly on the hour is unchanged), so the displayed close time is always honest. The everyone-has-voted early close stays event-driven (fires on the final vote, not the sweep). `TT_TEST_MODE=1` (testing only) sweeps every minute and rounds expirations up to the next minute, so short test polls stay usable.

### D6. Per-server config via `/ttdb-config` slash commands (chosen) vs config file
Slash commands, gated to members with **Manage Server**, keep config in-Discord and per-guild. A config file would require host access for every tweak.

## Difficult spots the spec walks into (and how the plan handles them)

- **"Only show" vs. needing vote controls:** solved by the single Vote button (D2).
- **Fixed option wording** "No, I'd rather not *invite them*…" doesn't fit channel-permanence polls → per-poll-type wording (Q1).
- **"Everyone on the server has voted" + percent threshold** require the member list → **Server Members** privileged intent must be enabled in the Developer Portal (Phase 1 `[HUMAN]` step). `guild.memberCount` alone can't exclude bots.
- **30-day timers** → hourly sweep (D5).
- **Button labels max 80 chars** → the long "No…" wording fits for invites (76 chars); permanence wording must be trimmed (Q1 default).
- **Mention injection:** an invitee name like `@everyone` must never ping — all rendering of user-supplied text uses `allowedMentions: { parse: ['everyone'] }` *only* on the poll content's intentional @everyone, and `parse: []` everywhere else (Phase 3/7).

## Open questions — `[HUMAN]` answers wanted (defaults apply if unanswered)

- [ ] `[HUMAN]` **Q1 — "No" option wording per poll type.** Invite polls use the spec text verbatim. Proposed default for channel-permanence: "No, I'd rather not, but I won't object if enough people want to" (fits 80-char button limit).
- [ ] `[HUMAN]` **Q2 — Who counts as "everyone"/"people in the server"?** Default: **bots excluded** everywhere; eligible-voter count and percent-threshold base are evaluated **at close time**; votes from members who left before close are dropped.
- [ ] `[HUMAN]` **Q3 — Which channel does the single-use invite point at?** Default: the server's **system channel**, falling back to the configured poll channel.
- [ ] `[HUMAN]` **Q4 — If a result DM can't be delivered** (user has DMs off): default: post a minimal, non-revealing notice in the poll channel — "@initiator I couldn't DM you your poll result — enable DMs from server members, then press [Resend result]" (button `tt:resend:<pollId>`, usable only by the initiator).
- [ ] `[HUMAN]` **Q5 — Data retention after close.** Default: delete all per-user vote rows at close; keep only the poll row (type, subject, initiator, outcome, veto count, timestamps) to support Q4's resend.
- [ ] `[HUMAN]` **Q6 — Who may start polls?** Default: any non-bot member who can see the configured poll channel (enforced naturally by button visibility).
- [ ] `[HUMAN]` **Q7 — Concurrent/duplicate polls.** Default: multiple polls may run at once, but starting an *exact* duplicate (same type + same normalized subject, still open) is refused with an ephemeral message.
- [ ] `[HUMAN]` **Q8 — Behavior before the server is fully configured.** Default: no built-in tally defaults; the init message appears once the poll channel is set, but pressing a poll button with `hard-no-weight` / `pass-threshold` (and, for permanence polls, `permanent-category`) unset replies ephemerally listing the missing `/ttdb-config` steps.
- [ ] `[HUMAN]` **Q9 — Where will the bot run long-term?** (Doesn't block implementation; see Post-Automation. Polls only collect votes while the process is up, so a machine that sleeps will effectively pause voting.)

---

## Phase 0 — Repo checkout & project scaffolding

### 0.1 Establish the git checkout

- [X] `git init -b main` in `C:\Users\Joe\the-the-discord-bot`
- [X] `git remote add origin git@github.com:zacronos/the-the-discord-bot.git` (gh is configured for ssh; if `git ls-remote origin` fails on host-key/agent issues, fall back to `git remote set-url origin https://github.com/zacronos/the-the-discord-bot.git` + `gh auth setup-git`)
- [X] `git fetch origin` then `git reset --hard origin/main` (safe: no local tracked files exist; untracked plan file and `logs/` are preserved) and `git branch --set-upstream-to=origin/main main`
- [X] Review the fetched `README.md` / `.gitignore` / `LICENSE`; extend `.gitignore` with: `node_modules/`, `logs/`, `data/`, `.env` (the fetched Node-template .gitignore already had all but `data/`; README is a bare title line, to be built out in later phases)
- [X] Commit this plan file + .gitignore update — `chore: add implementation plan and ignores` — and `git push` (first push verifies write access; if it's rejected, surface to `[HUMAN]`, but gh auth status makes this unlikely)

### 0.2 Node project scaffolding

- [ ] `package.json`: `"type": "module"`, `"engines": { "node": ">=24" }`, scripts: `start` (`node src/index.js`), `test` (`node --test test/`), `register-commands` (`node scripts/register-commands.mjs`), `invite-url` (`node scripts/invite-url.mjs`), `health-check` (`node scripts/health-check.mjs`)
- [ ] `npm install discord.js@^14.27.0` (sole runtime dependency)
- [ ] `src/env.js`: reads `DISCORD_TOKEN`, `DISCORD_APP_ID`, optional `TT_DB_PATH` (default `./data/the-the.sqlite3`), `TT_TEST_MODE`, `TT_GUILD_ID`; throws a clear error naming any missing required var. Document that humans may use a gitignored `.env` with `node --env-file=.env` (no dotenv dependency needed on Node ≥20.6).
- [ ] Smoke test `test/env.test.js` (missing-var error message), run `npm test` to green
- [ ] README: add "Development" section (Node ≥24, npm install, npm test, env var **names** and meanings). Commit `chore: scaffold node project` + push

## Phase 1 — Discord application bootstrap (helper scripts shrink the human residue)

### 1.1 Agent: helper scripts + docs first

- [ ] `scripts/health-check.mjs`: logs in with `DISCORD_TOKEN`, prints bot tag, app id, and joined-guild names/ids, then exits. Writes the same **redacted** output (never the token, no member data) to `logs/<ts>__health-check/run.log`. Exit code 1 with a plain-English hint on auth failure.
- [ ] `scripts/invite-url.mjs`: no secrets needed — from `DISCORD_APP_ID` prints the install URL with scopes `bot applications.commands` and permissions computed via `PermissionsBitField.resolve([ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory, MentionEveryone, CreateInstantInvite, ManageChannels, ManageRoles])` (ManageChannels+ManageRoles are needed later to move a channel and sync its permission overwrites)
- [ ] README: "Creating your Discord application" — numbered portal steps (below) — and "Inviting the bot to a server" using `npm run invite-url`. Commit `feat: app bootstrap scripts and setup docs` + push

### 1.2 Human: portal setup and first login

- [ ] `[HUMAN]` In https://discord.com/developers/applications → **New Application** (suggested name: "The The Bot") → **Bot** tab → toggle ON **SERVER MEMBERS INTENT** (required to know who has/hasn't voted) → **Reset Token** → copy it once. On **General Information**, copy the **Application ID**. Then in the PowerShell window you'll run the bot from (session-only, value never shown to the agent):
  ```powershell
  $env:DISCORD_TOKEN = '<paste-token-here>'
  $env:DISCORD_APP_ID = '<paste-application-id-here>'
  ```
  (Optional alternative: put the same two lines as `KEY=value` in a gitignored `.env` and run scripts with `node --env-file=.env …`.)
- [ ] `[HUMAN]` Run `npm run health-check` in that window
- [ ] Agent: read `logs/<ts>__health-check/run.log`, confirm login + intent OK, then **delete** the `logs/<ts>__health-check/` folder
- [ ] `[HUMAN]` Run `npm run invite-url`, open the printed URL, pick your server, **Authorize** (OAuth grants are human-only)

## Phase 2 — Storage, `/ttdb-config`, and the init message

### 2.1 Database layer (TDD against a temp db file)

- [ ] `src/db.js`: opens `node:sqlite` `DatabaseSync` at `TT_DB_PATH` (mkdir -p its folder), runs idempotent migrations:
  ```sql
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    poll_channel_id TEXT, init_message_id TEXT,
    hard_no_weight TEXT,            -- '-2'|'-3'|'-5'|'-10'|'veto'
    threshold_type TEXT,            -- 'count'|'percent'
    threshold_value REAL,
    permanent_category_id TEXT,
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
- [ ] `src/store/guildConfig.js` (`getConfig(guildId)`, `setConfig(guildId, patch)`), `src/store/polls.js` (`createPoll`, `getPoll`, `setMessageId`, `listDue(now)`, `listOpen(guildId)`, `closePoll(id, status, vetoCount)`), `src/store/votes.js` (`castVote(pollId, userId, choice)` upsert, `getVote`, `countByChoice(pollId)`, `countVoters(pollId)`, `deleteVotes(pollId)`)
- [ ] Tests first for each store module (`test/store/*.test.js`, temp db per test); run red → implement → green
- [ ] Commit `feat: sqlite storage layer` + push

### 2.2 `/ttdb-config` slash commands

- [ ] `src/features/configCommands.js` — one `/ttdb-config` command (default member permissions: **Manage Server**; guild-only) with subcommands:
  - `poll-channel channel:<text channel>` — also triggers init-message ensure (2.3) and warns ephemerally if the bot lacks any of: View Channel, Send Messages, Embed Links, Mention Everyone, Read Message History in that channel
  - `hard-no-weight weight:<choice of -2 | -3 | -5 | -10 | veto>`
  - `pass-threshold value:<number ≥ 0> unit:<choice of votes | percent>`
  - `permanent-category category:<category channel>` — warns if bot lacks Manage Channels / Manage Roles
  - `show` — ephemeral display of all current settings (and which are missing)
- [ ] Tests for the validation/formatting logic (command *handlers* as pure functions taking a fake interaction; no live Discord)
- [ ] `scripts/register-commands.mjs`: registers the command definitions via REST; guild-scoped to `TT_GUILD_ID` when set (instant), global otherwise (~1 h propagation). Redacted run log to `logs/<ts>__register-commands/run.log`.
- [ ] README: "Configuring the bot" — every subcommand, what it controls, and that polls refuse to start until required settings exist (Q8 default). Commit `feat: per-server configuration commands` + push
- [ ] `[HUMAN]` In the env-var PowerShell window: `$env:TT_GUILD_ID = '<your-server-id>'` (right-click server icon → Copy Server ID, with Developer Mode on) then `npm run register-commands`
- [ ] Agent: verify + delete `logs/<ts>__register-commands/`

### 2.3 Init message with feature buttons

- [ ] `src/features/initMessage.js` — `ensureInitMessage(guild)`: embed (footer marker `tt-init-v1`) explaining the two features, with buttons `tt:start:invite` ("Start a vote on inviting someone") and `tt:start:permchan` ("Start a vote on making a channel permanent"). Dedupe order: (1) stored `init_message_id` still exists → done; (2) scan last 100 channel messages for a bot-authored `tt-init-v1` footer → adopt it; (3) otherwise post fresh and store the id. When `poll-channel` changes, best-effort delete the old init message, then ensure in the new channel. Runs on startup for every configured guild and on every `poll-channel` change.
- [ ] Tests: dedupe decision logic with a mocked channel (exists / adoptable / absent; channel-change path)
- [ ] `src/index.js` + `src/discord/client.js`: client with intents `Guilds`, `GuildMembers`; `src/discord/interactionRouter.js` dispatches by `customId` prefix (`tt:`) and command name; `src/discord/customId.js` — `build(...parts)` / `parse(id)` helpers (tested)
- [ ] README: "How the poll channel works" (init message, buttons, what happens if it's deleted — reposted on next startup/config change). Commit `feat: init message and interaction routing` + push

## Phase 3 — Poll creation & anonymous voting framework

### 3.1 Creation modal

- [ ] `src/features/pollCreate.js` — on `tt:start:*`: check Q8 config gate (ephemeral list of missing settings if incomplete) and Q7 duplicate gate, else open modal `tt:create:<type>`:
  - **Text Display**: "This starts an anonymous poll in this channel, open to everyone on the server. Nobody can see how anyone voted. The poll closes after the duration you pick, rounded up to the next hour on the clock — or as soon as everyone on the server has voted. When it closes, results are tallied (current settings: a **Hard no** counts as `<hard-no-weight>`; passing requires `<threshold: N votes | N% of members>`) and the outcome is DM'd to you. ⚠️ A shorter poll may reach a result quicker, but leaves less time for everyone to see it and vote — avoid shorter durations unless there is a real reason for urgency."
  - Invite type: **Text Input** `name` (label "Who should we invite?", max 80 chars)
  - Permanence type: **Channel Select** `channel` (text channels only)
  - Both: **String Select** `duration` — options 3/5/7/14/30 days (7 = default-selected); with `TT_TEST_MODE=1`, extra options "5 minutes (TESTING ONLY)" / "30 minutes (TESTING ONLY)"
  - Fallback if any modal component is rejected at runtime: D4's ephemeral-panel flow
- [ ] Tests: modal/duration builders (default marked, test-mode additions), config-gate + duplicate-gate logic

### 3.2 Poll message

- [ ] On modal submit: validate subject (name trimmed, 1–80 chars; channel is a text channel not already in the permanent category), compute `closes_at = roundUpToNextHour(created_at + duration)` (`src/util/time.js`; epoch-hour ceiling, exact-hour values unchanged; with `TT_TEST_MODE=1` round up to the next minute instead), insert poll row, post to the poll channel: content `@everyone` with `allowedMentions: { parse: ['everyone'] }`, embed showing **only**: who initiated, what the poll is about ("Should we invite **{name}** to the server?" / "Should {#channel} be made permanent?"), responded count, not-yet-responded count, closes `<t:…:R>` — plus one **Vote / change my vote** button (`tt:vote:<pollId>`). Store `message_id`. Reply ephemerally to the initiator with a link to the poll.
- [ ] Eligible-voter helper `src/features/eligibility.js`: fetch members, count non-bots (per Q2), cache 60 s per guild
- [ ] Tests: embed renderer (pure: poll row + counts → embed fields), subject sanitation (a name of `@everyone`/`<@123>` renders inert), `roundUpToNextHour` (mid-hour rounds up; exact hour unchanged; test-mode minute rounding)

### 3.3 Ephemeral ballot

- [ ] `src/features/ballot.js` — `tt:vote:<pollId>`: ephemeral reply showing "Your current vote: **X**" (or "You haven't voted yet") + four buttons `tt:cast:<pollId>:<choice>` labeled per Q1 wording ("Yes!" / "No, I'd rather not invite them, but I won't object if enough people want to" / "Hard no, I really don't want this" / "I abstain from voting"); votes may be changed until close; casting updates the ephemeral message in place and refreshes the public counts (throttled: at most one embed edit per poll per 5 s)
- [ ] Closed/unknown poll → ephemeral "this poll has closed"
- [ ] After every cast: if `countVoters(pollId) >= eligibleCount`, trigger the close pipeline immediately (everyone-voted early close)
- [ ] Tests: cast/change/upsert flows, throttle logic, early-close trigger condition
- [ ] README: "Starting a poll" + "Voting and privacy" (what's public, what's private, changing your vote, early close). Commit `feat: poll creation and anonymous voting` + push

## Phase 4 — Closing engine

### 4.1 Tally (pure function, exhaustive tests first)

- [ ] `src/polls/tally.js`:
  ```js
  // tallyPoll({ counts, hardNoWeight, threshold, eligibleCount })
  //   counts: { yes, no, hard_no, abstain }   hardNoWeight: '-2'|'-3'|'-5'|'-10'|'veto'
  //   threshold: { type: 'count'|'percent', value: number }
  //   returns { outcome: 'passed'|'failed'|'vetoed', vetoCount, total, target }
  ```
  yes=+1, abstain=0, no=−1, hard_no=configured weight; any hard_no under `'veto'` ⇒ vetoed; else passed iff `total >= target` where target = `value` (count) or `(value/100) * eligibleCount` (percent)
- [ ] Test table: single veto overrides big yes majority; each numeric weight; exact-boundary equality passes (both units); percent scales with eligibleCount; all-abstain vs `value: 0` passes; empty poll fails any positive threshold
- [ ] Commit `feat: vote tally rules` + push

### 4.2 Scheduler & close pipeline

- [ ] `src/features/scheduler.js`: sweep **once per hour, on the hour** (`setTimeout` aligned to the next clock-hour boundary, then hourly; `TT_TEST_MODE=1` sweeps every minute) — each sweep closes polls with `closes_at <= now` (D5) and refreshes open-poll embed counts (membership may have changed); on startup — immediately close any polls that came due while the bot was down
- [ ] `src/features/pollClose.js` — atomic claim (`UPDATE polls SET status='closing' WHERE id=? AND status='open'`, skip if no row changed), then: drop votes from users no longer in the guild (Q2) → tally → DMs → on `passed` run the poll-type action (Phases 5/6) → delete the poll message (ignore already-deleted) → persist final status + veto_count → apply Q5 retention (delete vote rows)
- [ ] DM texts (send sequentially, ~500 ms apart; Q4 fallback on failure):
  - vetoed → initiator: "Your poll "<subject>" was vetoed by <N> member(s), so it did not pass. Please refrain from starting this poll again unless community concerns can be alleviated through private conversation."
  - vetoed → each vetoer: "The poll "<subject>" failed because of your veto. It may be helpful to privately discuss your concerns with <initiator>, who started it."
  - failed → initiator (no numbers): "Your poll "<subject>" did not pass. Please refrain from starting it again unless community concerns can be alleviated."
  - passed → initiator: "Your poll "<subject>" passed!" + action-specific content (Phases 5/6)
- [ ] Abort path: poll message or channel found deleted while open → status `aborted`, DM initiator a brief explanation
- [ ] Tests: due-selection, idempotent claim (double-close is a no-op), DM ordering/recipients per outcome (mocked transport), retention applied
- [ ] README: "How results are decided" (weights, veto, both threshold units with worked examples, close conditions, poll deletion, what the initiator does/doesn't learn). Commit `feat: poll closing engine` + push

## Phase 5 — "Invite someone" success action

- [ ] `src/features/actions/invite.js`: on pass, create invite on the Q3 target channel — `createInvite({ maxUses: 1, maxAge: 604800, unique: true, reason: 'Poll <id> passed' })` — and include the URL in the initiator's success DM: "Here is a single-use invite link, valid for 7 days, to send to <name>: <url>"
- [ ] Missing Create Instant Invite permission → still DM success, but explain the bot couldn't create the link and an admin should (also log)
- [ ] Tests: invite options, permission-failure path (mocked channel)
- [ ] README: feature walkthrough under "Poll types". Commit `feat: invite-someone poll action` + push

## Phase 6 — "Make channel permanent" success action

- [ ] `src/features/actions/permanentChannel.js`: on pass — verify configured category still exists, then `channel.setParent(categoryId, { lockPermissions: true, reason: 'Poll <id> passed' })` (moves the channel *and* syncs its permission overwrites with the category, per spec)
- [ ] Failure paths (category deleted, missing Manage Channels/Manage Roles, channel deleted mid-poll) → success DM still sent with a clear "action needs an admin" note + log
- [ ] Creation-time guard recap (from 3.2): only text channels, not already in the permanent category
- [ ] Tests: setParent args include `lockPermissions: true`; each failure path
- [ ] README: feature walkthrough. Commit `feat: permanent-channel poll action` + push

## Phase 7 — Hardening, polish, final docs

- [ ] Global interaction error handler: ephemeral "Something went wrong — the details were logged." + console log; process-level `unhandledRejection` logging
- [ ] Startup permission audit per configured guild: log any missing channel/category permissions in one readable block
- [ ] Guild-leave cleanup: open polls in that guild → `aborted`
- [ ] Input hygiene sweep: every render of user-supplied text (names) uses `allowedMentions: { parse: [] }` or embed-only placement; name length limits enforced server-side
- [ ] Final README pass: intro, feature list, invite+configure quick-start (top of file), self-hosting guide (env var names, `npm start`, data file location/backup), privacy notes (D2 honesty note), troubleshooting (missing intent, missing permissions, commands not appearing)
- [ ] Delete any remaining analyzed `logs/<ts>__*` folders
- [ ] Final `npm test` green; commit `chore: hardening and final docs` + push; verify remote `main` matches local (`git status` clean, `git log origin/main..main` empty)

## Post-Automation (human, after the agent's automatable work — no checkboxes)

- Live end-to-end pass on a real (or throwaway) server with `TT_TEST_MODE=1`: configure all four settings; run an invite poll and a permanence poll with 5-minute durations (test mode sweeps every minute; production sweeps hourly on the hour); vote from 2+ accounts; exercise a veto outcome, a failed outcome, and both pass actions (invite link redeems once; channel moves + perms sync); confirm DMs, vote-change, early close when everyone votes, and poll-message deletion.
- Decide hosting (Q9) and set it up. Options: **this PC** (free; polls pause while it sleeps — pm2/NSSM for auto-restart), **small VPS** (~$5/mo, always on, pm2 + `pm2 save`), **container host** (Railway/Fly; mind SQLite volume persistence). The startup catch-up (4.2) closes overdue polls after any downtime.
- Rotate the bot token immediately if it's ever pasted anywhere public; re-run the Phase 1 env-var step after rotating.
- Occasionally back up `data/the-the.sqlite3` (stop the bot first, copy the file).

## References

- Discord getting-started (starting point per spec): https://docs.discord.com/developers/quick-start/getting-started — note it demos the HTTP-endpoint style; D1 explains why this bot uses the gateway instead
- Components reference (modal capabilities verified 2026-08-07): https://docs.discord.com/developers/components/reference
- discord.js v14 guide: https://discordjs.guide
- Prior art for private ballots (per spec): https://github.com/cdsmith/votebot — "Electable" (Python); its Vote-button → ephemeral-ballot pattern is what D2 adopts
