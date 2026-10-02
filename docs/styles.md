# Reply styles and Claude Code skills

## Reply styles ("modes")

A reply style changes how Lumen words its answers, spoken replies and screen descriptions, for
example shorter, friendlier or more formal. It never changes what Lumen does: the mode it picks,
its actions and tools, the safety checks, warnings and the questions it asks before acting stay
the same, in plain words.

Lumen ships five: **brief** (levels lite, full, ultra), **teacher**, **friendly**, **formal** and
**explain like I'm new**.

- **Voice:** "turn on brief mode", "brief mode ultra", "set the level to lite", "normal mode",
  "brief mode off", "what mode am I in".
- **Settings → Skills → Reply style**: the same choice and level. The style in use shows as a
  small chip on the assistant bar and stays on until you turn it off.
- **Make your own:** "make a style that talks like a sports commentator". Lumen writes a draft;
  say "read it back", "call it" and a name, "save it" or "discard it". You can also edit the
  file in Settings → Skills.

### Writing a style

A style is a skill with `kind: style` in its header. The body says how replies should sound.

```markdown
---
name: caveman
description: Very few words.
kind: style
levels: [lite, full, ultra]
---

Drop filler words. Keep facts, numbers and warnings exact.

## Level: lite

Short normal sentences.

## Level: ultra

Fragments only.
```

- `levels` is optional; the first one is the default. Text before the first `## Level:` section
  applies to every level.
- Styles get no permissions, triggers or tools: they are never run as tasks and never offered to
  the AI as skills.
- Lumen puts the text in a fenced `<reply_style>` block with a rule that it shapes wording only;
  angle brackets in it are removed. Builtin and your own styles are kept up to 2,000 characters.
  A community style you have not trusted is cut to 600 characters.

## Importing from Claude Code

**Settings → Skills → Import from Claude Code** takes a Claude Code plugin or marketplace from a
GitHub link or a folder, or your own Claude Code setup (**Import my Claude Code skills**:
`~/.claude/skills`, `~/.claude/commands`, `~/.claude/output-styles` and the installed plugins).
Before anything is written, a preview lists every skill and connector and what changes.

| Claude Code                                 | In Lumen                                                          |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `skills/<name>/SKILL.md`                    | a skill; text, data and image files next to it are kept           |
| `commands/<name>.md`                        | a skill; names of two or more words become a voice phrase         |
| `output-styles/<name>.md`                   | a reply style                                                     |
| `.mcp.json` / `mcpServers` in plugin.json   | connectors, each only after you tick "I trust"                    |
| `$ARGUMENTS`                                | the skill's `arguments` value                                     |
| `$0`, `$1` … / `$ARGUMENTS[0]` …            | values `arg1`, `arg2` … (counted from 0, as Claude Code does now) |
| hooks, agents, scripts, LSP servers, `bin/` | not imported                                                      |

- **Least privilege.** Imported skills start as untrusted community skills: they ask before
  every action and get no mouse, keyboard, web, file or connector access until you edit their
  permissions. `allowed-tools`, `model`, `context: fork` and other Claude Code fields are dropped
  with a note in the preview.
- **Nothing runs.** Lines that ran a command when Claude Code loaded a skill (`` !`git status` ``)
  stay as plain text. Scripts are never copied.
- **Hooks are never imported.** A hook runs a command on your PC whenever Claude Code does
  something (a tool call, a finished turn). Lumen does not run programs from things it imports.
- **Updating.** Import the same source again to update in place. A skill keeps your trust only
  while its content stays the same; changed content starts untrusted again. A name another skill
  already uses gets the plugin's name in front.
- **Marketplaces.** Plugins inside the same repository are imported. From a GitHub link, plugins
  the marketplace lists on GitHub are downloaded too (at most 12, 150 MB together; **Stop**
  cancels the downloads). A folder or `~/.claude` import stays offline: it names those plugins in
  the preview so you can import their own link.
- **Connector settings.** Values a plugin sets for a connector are shown in the preview (secrets
  masked) and used only when ticked. Settings that change which program runs (`PATH`,
  `NODE_OPTIONS`, `PYTHONPATH`, package registry and proxy settings …) are never taken.
