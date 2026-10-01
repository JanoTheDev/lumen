# Connectors

A connector is an [MCP](https://modelcontextprotocol.io) server. Its tools become available to
Lumen's agent tasks, next to the screen tools. Lumen ships no connectors switched on; you add the
servers you want in **Settings → Connectors**, from **Browse integrations** or by hand.

## Browse integrations

The catalog lists well-known servers, each with a link to its maker's own documentation and the
date its address and sign-in were last checked. Click **Add**:

- **Sign in** (Notion, Linear, Sentry, Supabase, Stripe, PayPal, Intercom, Webflow): your
  browser opens the provider's sign-in page. Lumen registers itself with the server, waits for the
  browser to come back to `http://127.0.0.1:<port>/callback` on this PC, and stores the sign-in.
- **Access token** (GitHub, monday.com, Zapier, and optionally Linear, Supabase, Stripe,
  Intercom, Hugging Face, Context7): paste the token the server's docs describe.
- **No sign-in** (DeepWiki, Microsoft Learn, Cloudflare docs, Figma desktop).
- **Local commands** (Files, Git, Fetch, Time, Playwright, Chrome DevTools …) show the exact
  command line and need **I trust this command**, like any local command. Most need
  [Node.js](https://nodejs.org) or [uv](https://docs.astral.sh/uv/) (free); the entry says which.

Servers that only accept apps their maker approved (for example Asana, HubSpot, Box, Vercel and
Figma's hosted server) are not in the catalog: they cannot be signed in to from Lumen.

## How Lumen uses a connector

- **Two kinds.** _Local command_: Lumen starts a program on your PC and talks to it over
  stdin/stdout. _Web server_: Lumen connects to an `https://` URL (plain `http://` only for a
  server on this PC), with an access token sent as `Authorization: Bearer …`, an OAuth sign-in,
  or neither.
- **Sign-in (OAuth).** Lumen uses the MCP authorization flow: authorization code with PKCE and
  dynamic client registration, the redirect to `127.0.0.1` on this PC. The sign-in is refreshed
  by itself while it is valid; when it ends, the connector says "Not signed in" and **Sign in**
  under it starts again. **Sign out** deletes the stored sign-in. Any web server can try **Sign in
  with OAuth**; servers that need an approved app refuse it.
- **Trust.** A local command runs with your Windows permissions. Settings shows the exact command
  line and only adds it after you tick **I trust this command**. Changing the command or its
  arguments needs the tick again.
- **Secrets.** Access tokens, sign-ins (OAuth tokens and the registration) and environment
  variable values are encrypted with Windows DPAPI in `~/.ai-overlay/connectors.dat`, never
  shown again and never written to the log. `~/.ai-overlay/connectors.json` holds
  everything else (names, commands, URLs, tool settings) and no secrets.
- **When it connects.** Only when an agent task starts and the connector is switched on. A server
  that fails is left out of that task and retried later (1 s, 5 s, 15 s, then every minute).
  **Test** in Settings connects right away and shows the tool count or the error.
- **Tool names.** The model sees each tool as `mcp__<connector id>__<tool>`, for example
  `mcp__files__read_text_file`.
- **Safety.** Every call goes through the same safety policy as clicks and key presses:
  - A tool the server marks as destructive, or whose name says it writes, deletes, sends or moves
    something, always asks you first. This cannot be turned off.
  - Any other tool asks before it runs. Say "always" to allow that tool from now on.
  - Per tool, Settings offers **Ask until allowed** (default), **Ask every time**, **Allow**, and
    **Off**. A tool set to Off is never offered to the model. Allow does not skip the question
    for tools that change data.
- **Results are data.** Tool results reach the model marked as observed content
  (`<observed source="mcp:<id>">`), with secrets masked. Instructions inside a result are
  treated as text, not as your request.
- **Limits.** A call times out after 30 seconds. Results longer than 20,000 characters are cut,
  with a note saying how much was left out.

## Example: a folder on your PC

The reference [filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
can only reach the folders you list. It needs [Node.js](https://nodejs.org) (free).

1. Settings → Connectors → **Add a connector**, kind **Local command**.
2. Name: `Files`.
3. Command: `npx`
4. Arguments, one per line:

   ```text
   -y
   @modelcontextprotocol/server-filesystem
   C:\Users\you\Documents\Notes
   ```

5. Check the command line shown, tick **I trust this command**, click **Add**, then **Test**.
6. Optional: click **Show tools** and set `write_file`, `edit_file` and `move_file` to **Off**
   to keep the connector read-only. (They always ask first anyway.)

Then ask, for example, "find my notes about the dentist and tell me the date".

## Example: calendar or email

Lumen has no built-in calendar or email connector. Pick an MCP server for your provider, check
who publishes it and what it can do, and add it:

- **Runs on your PC** (most community servers): kind **Local command**. Put the API key or app
  password the server's readme asks for under **Environment variables** as `NAME=value`, one per
  line. They are stored encrypted and passed only to that command.
- **Hosted by the provider**: kind **Web server**, with the server URL and an access token if it
  uses one, or **Sign in with OAuth** after adding it.

Tools that send mail or change events count as writing and always ask first. Lumen's agent never
sends on its own: it drafts, and you send.

## Example: DaVinci Resolve Studio

Resolve Studio 21.1 and later include an MCP server (the free edition does not). Lumen can use it
as a connector for questions about your project. Its transport and tool list are not checked yet,
so follow Blackmagic's documentation for the address or command, then:

1. Add it as a **Web server** or **Local command**, as the documentation says.
2. **Show tools**, and set every tool that renders, moves, deletes or changes media to **Off**.
   Lessons only need read-only tools.

Without Studio, Resolve lessons check your progress from the screen; see Settings → App helpers.

## From Claude Code plugins

**Settings → Skills → Import from Claude Code** reads a plugin's `.mcp.json` (and the
`mcpServers` in its `plugin.json`). Each server is offered as a connector with its exact command
line or address, and only the ones you tick ("I trust this command") are added. Servers that
run a program from inside the plugin (`${CLAUDE_PLUGIN_ROOT}`), use the old SSE or WebSocket
transports, or build their headers with a command are left out. Values a server reads from your
environment (`${API_KEY}`) are listed: add them under the connector afterwards.

## Troubleshooting

- **"Could not connect"** with a local command: run the same command line in a terminal. A missing
  program (for example Node.js for `npx`) shows up there. The last lines the server printed to
  its error output are included in the message.
- **Web server rejected**: check the URL starts with `https://` and that the token is current.
  Under the connector, paste a new token to replace the saved one, or use **Remove token**.
- **A tool is missing** in a task: it may be set to **Off**, or the server failed to connect at the
  start of the task (it is retried at the next task).
