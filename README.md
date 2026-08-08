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
requests the `bot` and `applications.commands` scopes plus exactly the
permissions the bot needs:

| Permission | Why the bot needs it |
|---|---|
| View Channel, Send Messages, Embed Links, Read Message History | Operate the poll channel |
| Mention Everyone | Announce new polls with `@everyone` |
| Create Instant Invite | Generate the single-use invite link when an invite poll passes |
| Manage Channels, Manage Roles | Move a channel into the permanent category and sync its permissions when a permanence poll passes |

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
| `pass-threshold value:<number> unit:<votes \| percent>` | yes | The vote total needed to pass: a literal total, or a percent of the server's current (non-bot) members |
| `permanent-category category:<category>` | yes | The category a channel moves into when a make-it-permanent poll passes |
| `invite-channel channel:<#channel>` | no | Where invite links from passed invite polls land; unset = the server's system channel |
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
- On every startup (and config change) the bot compares the message against
  what the current code would send; if an update changed the wording or
  buttons, the existing message is **edited in place** — same message, no
  repost.
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
open) are refused; and channels already in the permanent category can't be
nominated again.

## Voting and privacy

A new poll pings `@everyone`. Publicly, the poll shows only who started it,
what it asks, how many people have voted, how many haven't, and when it
closes — never who voted or how.

Press **Vote / change my vote** to get a private ballot only you can see,
with four options: *Yes!*, *No, I'd rather not…*, *Hard no*, and *I abstain
from voting*. Your ballot shows your current vote, and you can change it
any time until the poll closes. The poll closes at its scheduled hour — or
immediately, once every (non-bot) member of the server has voted.

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

Asks which text channel should become permanent (channels already in the
permanent category can't be nominated) and the poll duration. If the poll
passes, the bot **moves the channel into the configured
`permanent-category` and syncs its permission overwrites** with that
category. If the move fails (category deleted, or the bot lacks Manage
Channels / Manage Roles), the DM still reports the pass with a note asking
an admin to finish the move manually.

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
Otherwise the poll **passes when the total reaches the configured
threshold** — either a literal vote total, or a percent of the server's
current non-bot members (evaluated at close time; votes from members who
left the server are dropped). Reaching the threshold exactly counts as
passing. Example with `pass-threshold 50 percent` in a 10-person server:
6 Yes + 1 No + 1 Hard no (−3) = total 0 → fails; 8 Yes + 2 Abstain =
total 8 → passes (target 5).

When a poll closes, its message is deleted from the poll channel and all
individual votes are erased — only the outcome is kept. The initiator gets
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

Caveat: the bot only collects votes while this machine is awake and logged
in. Missed poll closes are caught up at the next hourly sweep or startup.
Occasionally back up `data/the-the.sqlite3` (stop the bot first, copy the
file).

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
