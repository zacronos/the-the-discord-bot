# the-the-discord-bot

A Discord bot for running anonymous community polls: invite votes ("should we
invite this person to the server?") and channel-permanence votes ("should this
channel become permanent?"), with per-server configurable counting rules.

*(Built from [the implementation plan](2026-08-07__discord-bot-implementation-plan.md),
which also records every design decision.)*

## Quick start (server owner)

1. [Create your Discord application](#creating-your-discord-application) —
   portal setup, token, intents.
2. [Invite the bot to your server](#inviting-the-bot-to-a-server).
3. [Register the slash commands and configure](#configuring-the-bot) with
   `/ttdb-config` — polls unlock once the four required settings are set.
4. Run the bot: `npm start`, or set up
   [auto-start on Windows](#running-on-startup-windows).

## Creating your Discord application

1. Go to <https://discord.com/developers/applications> and press **New
   Application** (suggested name: "The The Bot").
2. Open the **Bot** tab and set two toggles: turn OFF **Public Bot**, so
   only you (the application owner) can add the bot to servers — anyone can
   derive the install URL from the public Application ID, so this toggle is
   the real access control. Then, under *Privileged Gateway Intents*, toggle
   ON **SERVER MEMBERS INTENT** — the bot needs it to know who has and
   hasn't voted (for early poll closes and percent-based thresholds).
3. Still on the **Bot** tab, press **Reset Token** and copy the token.
4. On **General Information**, copy the **Application ID**. (No need to
   upload an App Icon — the bot pushes
   [assets/bot-icon-1024.png](assets/bot-icon-1024.png) itself on startup;
   vector source: [assets/bot-icon.svg](assets/bot-icon.svg).)
5. Create a file named `.env` in the repo root (it's gitignored — never
   commit it) containing exactly two lines:

   ```
   DISCORD_TOKEN=<paste-token-here>
   DISCORD_APP_ID=<paste-application-id-here>
   ```

   Every `npm run` script and the bot itself read this file automatically.
   Treat the token like a password: never paste it into chat or anywhere
   else.
6. Verify the setup:

   ```bash
   npm run health-check
   ```

   On success this prints the bot user and its servers; on failure it prints
   a plain-English hint (bad token vs. missing intent). A redacted copy goes
   to `logs/<timestamp>__health-check/run.log` — it never contains the token.

## Inviting the bot to a server

```bash
npm run invite-url
```

Open the printed URL, pick your server, and press **Authorize**. With
**Public Bot** turned off, only you (the application owner) can complete
this step, so the bot cannot end up on servers you didn't choose. The URL
requests the `bot` and `applications.commands` scopes plus the
**Administrator** permission for the server. Administrator covers
everything the bot does — operating the poll channel, announcing polls
with `@everyone`, creating the single-use invite link when an invite poll
passes, moving channels into the permanent category — and, unlike a
granular permission list, it can't be hidden from a private channel by
that channel's permission overwrites, which
[private-channel polls](#private-channels) depend on.

Already invited the bot back when the URL requested narrower permissions?
Either open the invite URL again and re-authorize the same server, or
enable **Administrator** on the bot's managed role directly (Server
Settings → Roles).

## Configuring the bot

One-time after inviting the bot, register its slash commands (add
`TTDB_GUILD_ID=<your-server-id>` to your `.env` first so the commands
appear instantly in your server instead of globally within an hour):

```bash
npm run register-commands
```

All configuration happens in Discord via `/ttdb-config`, usable only by
members with the **Manage Server** permission. Poll features check these
settings and refuse to start until all four required ones have values.

| Subcommand | Required | What it controls |
|---|---|---|
| `poll-channel channel:<#channel>` | yes | The text channel polls are posted in |
| `hard-no-weight weight:<-2 \| -3 \| -5 \| -10 \| veto>` | yes | How strongly a "Hard no" vote counts against a poll's total; `veto` means a single hard no fails the poll |
| `pass-threshold value:<number> unit:<points \| percent> poll-type:<invite \| channel-permanence \| channel-deletion \| channel-deletion-other \| all>` | yes | The points total needed to pass: a literal points total, or a percent of the server's current (non-bot) members. `poll-type` (default: all) gives each poll type its own threshold; channel deletion has two — `channel-deletion` for channels in the configured permanent categories, `channel-deletion-other` for every other channel. Each deletion kind stays disabled until its threshold resolves |
| `max-open-polls value:<1–100>` | no | How many polls may be open at the same time; default 10 |
| `permanent-category category:<category> kind:<text \| voice>` | yes (text) | The category a channel moves into when a permanence poll passes. `kind` (default: text) sets separate categories for text and voice channels; until a voice category is set, voice channels can't be nominated |
| `invite-channel channel:<#channel>` | no | Where invite links from passed invite polls land; unset = the server's system channel |
| `other-permanent-groups category:<category> action:<add \| remove>` | no | Extra categories treated as permanent: their channels can't be nominated for permanence, are never offered for deletion, and are exempt from [creator-only deletion locks](#channel-creators-and-deletion-protection) (run once per category; `action` defaults to add) |
| `poll-starter-role role:<@role>` | no | Restrict poll *starting* to one role; unset = anyone. Voting is always open to everyone |
| `show` | — | Show current settings and anything still missing |

Every reply is private to you. When you configure a channel or category the
bot checks its own permissions there and warns you about anything missing
(e.g. Mention Everyone in the poll channel, Manage Channels/Roles on the
category). A percent threshold above 100 is rejected outright — it could
never pass.

### The bot's profile keeps itself up to date

On every startup and after every `/ttdb-config` change, the bot syncs its
own Discord profile:

- **About Me** — until the server is fully configured it reads
  "admins: use /ttdb-config to set up The The Admin-Polling Bot"; once
  configured it points members at the poll channel by name ("Go to the
  #votes channel to start a vote! …") and follows along if you change
  `poll-channel`.
- **App icon** — pushed from `assets/bot-icon-1024.png` whenever the file
  changes (tracked by content hash, so no needless uploads).

## How the poll channel works

Once **all four required settings** have values, the bot posts a
"Start a community poll" message in the poll channel, with one button per
poll type. That message is the entry point for everything members do.

- The bot recognizes its own message (via an embed marker), so restarting
  the bot or re-running config never produces duplicates — even if the
  bot's database is lost, it re-adopts the existing message.
- The message itself documents the voting rules: how votes are totaled as
  points (including the configured hard-no weight) and the current pass
  threshold for each poll type.
- On every startup (and config change) the bot compares the message against
  what the current code and settings would produce; if anything changed —
  a code update, a new hard-no weight, a new threshold — the existing
  message is **edited in place**: same message, no repost.
- The message is kept **pinned**: every one of those scans re-pins it if
  it was ever unpinned.
- If the message gets deleted, the bot reposts it on its next startup or
  the next configuration change.
- If you change `poll-channel`, the old message is removed and a fresh one
  is posted in the new channel.

## Starting a poll

Press one of the buttons on the "Start a community poll" message. A form
opens that explains how the poll will be scored (using this server's
configured rules), asks for the subject — a person's name for invite votes,
a channel for permanence votes — and asks how long the poll should stay
open: 3, 5, 7 (default), 14, or 30 days. Shorter polls reach results
quicker but leave less time for everyone to see them and vote, so avoid
short durations unless there's real urgency. The close time is rounded up
to the next hour on the clock.

Guard rails: if a `poll-starter-role` is configured, only members with that
role can start polls; duplicate polls (same type and subject as one still
open) are refused; at most `max-open-polls` polls (default 10) can be open
at the same time; channels already in the permanent category can't be
nominated again; and the channel dropdowns only offer (and only accept)
channels the initiating member can actually see.

## Voting and privacy

A new poll pings `@everyone`. Publicly, the poll shows only who started it,
what it asks, how many people have voted, how many haven't, when it
closes, and the pass rules it will be judged by (vote weights and the
applicable threshold — kept current on the message if an admin changes
them mid-poll) — never who voted or how.

Press **Vote / change my vote** to get a private ballot only you can see,
showing the poll question and four options: *Yes!*, *No, I'd rather not…*,
*Hard no*, and *I abstain from voting*. Casting a vote dismisses the
ballot immediately — press the button again any time before the poll
closes to see or change your vote. Untouched ballots (and the
poll-creation confirmation) clean themselves up after ~14 minutes. The poll closes at its scheduled hour — or
immediately, once every (non-bot) member of the server has voted.

If you started the poll, your own ballot also carries a **Withdraw this
poll** button: it cancels the poll for everyone, removes the public poll
message, and discards all votes (you get the cancellation by DM, like
any aborted poll).

**An honest note on anonymity:** votes are anonymous to everyone on
Discord, including server admins and the poll initiator. However, whoever
runs the bot host can technically read the bot's local database while a
poll is open. Individual votes are erased the moment a poll closes; only
the outcome is kept.

## Poll types

### Start a vote on inviting someone

Asks for the person's name and the poll duration. If the poll passes, the
bot creates a **single-use invite link valid for 7 days** and includes it
in the initiator's result DM, ready to forward to the invitee. The link
lands new members in the configured `invite-channel` (or the server's
system channel if unset). If the bot can't create the link (e.g. missing
Create Instant Invite permission), the DM still reports the pass and asks
an admin to create the invite manually.

### Start a vote on making a channel permanent

Asks which channel — text or voice — should become permanent. The dropdown
lists only channels **not already inside any permanent group** (the two
configured permanent categories and every `other-permanent-groups`
category are excluded; Discord select menus cap the list at 25). If the poll passes, the bot **moves the channel into the
permanent category for its kind** (text channels into the `kind:text`
category, voice channels into the `kind:voice` one — autodetected) **and
syncs its permission overwrites** with it. The sync also strips the
creator's [deletion lock](#channel-creators-and-deletion-protection) —
promoted channels belong to the community. Voice channels can only be
nominated once a voice category is configured. If the move fails (category
deleted, or the bot lacks Manage Channels / Manage Roles), the DM still
reports the pass with a note asking an admin to finish the move manually.

Nominating a **private** channel comes with an extra step: making a
channel permanent also makes it **public**, so the bot first shows you a
warning and only creates the poll after you press its acknowledgement
button. The poll itself (posted inside the channel, as always for private
channels) repeats that warning to voters. When such a poll passes, the
bot lifts the channel's `@everyone` view restriction **before** moving
and syncing it.

### Start a vote on deleting a channel

Asks which channel should be deleted — the dropdown lists **every text
and voice channel you can see**, except channels inside the
`other-permanent-groups` categories (protected) and the configured poll
and invite channels, which keep the polls running (text prefixed
`#`, voice prefixed 🔊; Discord select menus cap the list at 25). Deletion
polls have **two** `pass-threshold`s: `poll-type:channel-deletion` covers
channels inside the configured permanent categories, and
`poll-type:channel-deletion-other` covers every other channel
(`poll-type:all` sets both). Whichever applies is chosen by **where the
channel is when the poll closes**. Channels of a kind whose threshold
isn't configured aren't offered; until either kind is, the button explains
what an admin needs to run. If the poll passes, the channel is
**scheduled for deletion 24 hours later, rounded up to the next hour on
the clock**, and the bot posts a warning in that channel with the exact
day and time. The deletion happens at that hour — or at the next bot
startup, if it was offline when the time arrived.

During that window, members with **Manage Server** can review and stop
pending deletions: `/ttdb-deletions list` shows every scheduled deletion
with its time and originating poll, and
`/ttdb-deletions cancel channel:<#channel>` calls one off — the bot posts
a notice in the channel saying the deletion was canceled and naming who
canceled it.

Two lifecycle guards prevent crossed outcomes: a channel voted permanent
while a deletion was already scheduled has that pending deletion
canceled by the promotion, and the sweep takes a last look before the
axe falls — a channel that has joined any permanent group since its poll
passed is spared and its schedule dropped. (Concurrent permanence and
deletion polls about the same channel are deliberately allowed:
refusing them would let a perpetually renewed permanence poll block
deletion votes forever.)

### Private channels

When the nominated channel is **private** (hidden from `@everyone`), the
poll is posted **inside that channel** instead of the poll channel — for a
voice channel, in its built-in text chat — so the channel's name is never
exposed to members who can't already see it. (The bot's **Administrator** permission guarantees it can
see the channel; if it was invited with the older, narrower permission
set and can't, creation fails with a clear message.) For these polls the voting population is the channel's viewers
rather than the whole server: a percent threshold applies to the number of
people who can see the channel, a literal threshold is capped at that
number, and the everyone-has-voted early close counts only them.

## Channel creators and deletion protection

The bot keeps a registry of every text and voice channel and who created
it. New channels are recorded the moment they're created (the creator is
read from the server's audit log); on startup the bot scans for channels
it doesn't know yet and records them retroactively. Discord keeps audit
log entries for ~45 days, so a channel much older than the bot's first
scan may be recorded with an unknown creator. Channels inside
`other-permanent-groups` categories are left entirely alone — neither
tracked nor touched.

Every recorded channel **outside the configured permanent categories** is
locked so that **only its creator can delete it**: the bot denies
**Manage Channels** on the channel for `@everyone` and grants it back to
the creator alone. Server **administrators keep that ability regardless**
— Discord's Administrator permission bypasses channel overwrites. Two
consequences worth knowing:

- Discord has no delete-only permission, so the lock uses **Manage
  Channels**, which also covers editing the channel (name, topic, …):
  non-creators lose that too, unless they're administrators.
- If the creator is unknown (audit log expired) or has left the server,
  the channel is simply locked for everyone below administrator. A
  returning creator gets their access restored by the daily check.

Channels inside the configured permanent categories are community
property: they're recorded, but never locked — deleting them is what
deletion polls are for. Deletion polls also remain the community's
override for locked channels, since the bot itself deletes the channel
when one passes.

Once a day the bot re-checks every recorded non-permanent channel and
corrects any drift: a missing `@everyone` deny, a missing creator grant,
or a Manage Channels grant someone slipped onto another role or member.

One asymmetry to know about: if a locked channel is later moved into an
`other-permanent-groups` category, the bot stops touching it entirely —
the creator lock it already carries (the `@everyone` Manage Channels
deny and the creator's grant) stays behind. Remove those overwrites by
hand if they're unwanted there.

Creator privileges can be handed over with
`/ttdb-set-creator channel:<#channel> member:<@member>` — usable by the
channel's recorded creator, or by anyone with **Manage Server** (which is
also how to fix channels whose creator the audit log never revealed). The
new creator must be a member who can see the channel; bots are refused.
The old creator's deletion grant moves to the new one. Channels inside
any permanent group are refused — their permissions belong to the
category, not a creator.

## How results are decided

A poll closes at its scheduled hour (the bot sweeps once per hour, on the
hour), or immediately once everyone has voted. Votes are then counted:

| Vote | Counts as |
|---|---|
| Yes! | +1 |
| No, I'd rather not… | −1 |
| I abstain from voting | 0 |
| Hard no | the configured `hard-no-weight`: −2 / −3 / −5 / −10, **or `veto`** |

If `hard-no-weight` is `veto`, a single Hard no fails the poll outright.
Otherwise the poll **passes when the point total at poll closing is at
least the configured threshold** (settable separately per poll type) —
either a literal points total, or a percent of the server's current
non-bot members (evaluated at close time from a member snapshot the bot
refreshes at most hourly — Discord rate-limits member fetching; votes from
members who left the server are dropped). Reaching the threshold exactly counts as passing.
**A poll that received no votes at all never passes.** If the member count
can't be determined when a percent-threshold poll comes due, the close is
postponed to the next sweep rather than decided on bad data.
Example with `pass-threshold 50 percent` in a 10-person server:
6 Yes + 1 No + 1 Hard no (−3) = point total 2 → fails; 8 Yes + 2 Abstain =
point total 8 → passes (target 5).

When a poll closes, its message is deleted from the poll channel and all
individual votes are erased — only the outcome is kept. Private ballot
panels opened in the last few minutes are dismissed too (Discord only lets
the bot remove an ephemeral message within ~15 minutes of it opening;
older ballots simply report the poll as closed if pressed). The initiator gets
the result by DM:

- **Passed** — plus the follow-up action's result (e.g. an invite link).
- **Did not pass** — no numbers are revealed, with a suggestion to hold off
  unless community concerns can be alleviated.
- **Vetoed** — how *many* members vetoed (never who), with the same
  suggestion; each vetoing member is also privately told the poll failed on
  their veto and encouraged to talk with the initiator directly.

If your DMs are closed, the bot posts a small notice in the poll channel
(revealing nothing) with a **Resend result** button only you can use.

## Running on startup (Windows)

The repo ships a user-level Task Scheduler setup (no admin rights needed).
The task runs `scripts/start-bot.cmd`, which reads the gitignored `.env`
and appends output to `data/bot.log` (previous run kept as `bot.log.1`).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1
```

```powershell
Start-ScheduledTask -TaskName TheTheDiscordBot
```

The task starts the bot at every logon and restarts it up to 3 times if it
crashes. Stop it with `Stop-ScheduledTask -TaskName TheTheDiscordBot`;
remove it with `scripts\uninstall-startup-task.ps1`.

To restart (e.g. after pulling new code), use the restart script — it also
cleans up any bot process the task lost track of, which otherwise blocks
the next start by keeping `data\bot.log` locked:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\restart-bot.ps1
```

Caveat: the bot only collects votes while this machine is awake and logged
in. Missed poll closes are caught up at the next hourly sweep or startup.
The bot snapshots its own database once a day into `data/backups/`
(newest 7 kept; taken safely while running via `VACUUM INTO`) — copy one
elsewhere occasionally if you want off-machine safety.

## Development

Requirements: **Node.js >= 24** (the project uses the built-in `node:sqlite`
and `node --test`; no build step).

```bash
npm install
npm test
```

### Environment variables

Configuration lives in a **gitignored** `.env` file in the repo root —
plain `KEY=value` lines, loaded natively by Node (no dotenv dependency).
Every `npm run` script and the startup task read it automatically. Never
commit it.

| Name | Required | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token from the Developer Portal. **Secret — never share or commit it.** |
| `DISCORD_APP_ID` | yes | The application ID (public, not a secret). |
| `TTDB_DB_PATH` | no | SQLite database location. Default: `./data/the-the.sqlite3`. |
| `TTDB_TEST_MODE` | no | Set to `1` to enable short "TESTING ONLY" poll durations and minute-level sweeps. Never use on a real server. |
| `TTDB_GUILD_ID` | no | If set, slash commands are registered guild-scoped (instant) instead of globally (~1 h to propagate). |

Changes to `.env` take effect the next time a script runs or the bot
starts (restart the bot to pick them up).

## Troubleshooting

### `npm : File ...\npm.ps1 cannot be loaded because running scripts is disabled`

PowerShell's default execution policy (`Restricted`) blocks npm's PowerShell
shim. Fix it once for your user account (no admin needed, takes effect
immediately):

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
```

`RemoteSigned` allows locally installed scripts (like npm's shim) while
still requiring signatures on scripts downloaded from the internet. If you
prefer not to change the policy, call the cmd shim instead, which skips the
`.ps1` file entirely: `npm.cmd run <script>`.

### `/ttdb-config` doesn't appear in Discord

Run `npm run register-commands`. With `TTDB_GUILD_ID` set the commands are
guild-scoped and appear instantly; without it they're global and can take
up to an hour. Also confirm the bot was invited with the
`applications.commands` scope (the `npm run invite-url` link includes it).

### The bot exits immediately with "Used disallowed intents"

Enable **SERVER MEMBERS INTENT**: Developer Portal → your app → Bot →
Privileged Gateway Intents. `npm run health-check` diagnoses this.

### Votes aren't being collected / a poll didn't close on time

The bot only collects votes and closes polls while its process is running.
After downtime, the next startup (or the next hourly sweep) closes any
polls that came due in the meantime. On startup the bot also logs a
permission audit — check the console/log for lines starting with
`[ttdb] permission audit`.
