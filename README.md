# the-the-discord-bot

A Discord bot for running anonymous community polls: invite votes ("should we
invite this person to the server?") and channel-permanence votes ("should this
channel become permanent?"), with per-server configurable counting rules.

*(Implementation in progress — see
[the implementation plan](2026-08-07__discord-bot-implementation-plan.md).)*

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
4. On **General Information**, copy the **Application ID**. While there, you
   can also upload [assets/bot-icon-1024.png](assets/bot-icon-1024.png) as
   the **App Icon** (vector source: [assets/bot-icon.svg](assets/bot-icon.svg)).
5. In the shell you'll run the bot from, set both values (session-only;
   alternatively put them in a gitignored `.env` — see
   [Development](#development)):

   ```powershell
   $env:DISCORD_TOKEN = '<paste-token-here>'
   $env:DISCORD_APP_ID = '<paste-application-id-here>'
   ```

   Treat the token like a password: never commit it, never paste it into
   chat or anywhere else.
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

One-time after inviting the bot, register its slash commands (in the same
shell where the env vars are set; setting `TTDB_GUILD_ID` to your server's
ID makes the commands appear instantly instead of within an hour):

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

## How the poll channel works

Once **all four required settings** have values, the bot posts a
"Start a community poll" message in the poll channel, with one button per
poll type. That message is the entry point for everything members do.

- The bot recognizes its own message (via an embed marker), so restarting
  the bot or re-running config never produces duplicates — even if the
  bot's database is lost, it re-adopts the existing message.
- If the message gets deleted, the bot reposts it on its next startup or
  the next configuration change.
- If you change `poll-channel`, the old message is removed and a fresh one
  is posted in the new channel.

## Development

Requirements: **Node.js >= 24** (the project uses the built-in `node:sqlite`
and `node --test`; no build step).

```bash
npm install
npm test
```

### Environment variables

Configuration is read from environment variables. Set them in your shell, or
put `KEY=value` lines in a **gitignored** `.env` file and run commands via
`node --env-file=.env ...` (supported natively by Node, no dotenv needed).
Never commit secrets.

| Name | Required | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token from the Developer Portal. **Secret — never share or commit it.** |
| `DISCORD_APP_ID` | yes | The application ID (public, not a secret). |
| `TTDB_DB_PATH` | no | SQLite database location. Default: `./data/the-the.sqlite3`. |
| `TTDB_TEST_MODE` | no | Set to `1` to enable short "TESTING ONLY" poll durations and minute-level sweeps. Never use on a real server. |
| `TTDB_GUILD_ID` | no | If set, slash commands are registered guild-scoped (instant) instead of globally (~1 h to propagate). |

Note: `$env:` variables only live as long as that PowerShell window. If you
open a new window, set them again — or keep them in the gitignored `.env`.

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
