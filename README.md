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
4. On **General Information**, copy the **Application ID**.
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
