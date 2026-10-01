# Skill pack schemas and validator

The JSON Schemas here describe a skill pack (`skill.json`, `regions.json`, `curriculum.json`) and
its lessons (`lessons/*.lesson.json`). `validate.mjs` checks a pack against them plus the rules a
schema can't express (file names, cross references, size caps, the "write for the ear" lint).
The same code runs in the CLI and when Lumen installs a community pack.

## Validate

```bash
npm run validate:skills                                 # every pack under skills/
node scripts/validate-skills.mjs path/to/skills         # every pack in another folder
node scripts/validate-skills.mjs --pack path/to/mypack  # one pack folder
```

One line per problem (`<file>: <json path>: <message>`), exit code 1 when anything is wrong.

## A pack folder

```
myapp/                 folder name = skill.json "id"
  skill.json           id, name, version, match rules, uiaQuality
  overview.md          what the app is, ≤ ~1500 tokens
  shortcuts.md         table: Action | Shortcut | Mode/context
  glossary.md
  regions.json         named screen regions as window fractions
  SOURCES.md           where the facts come from
  curriculum.json      optional: units → lesson ids
  lessons/<id>.lesson.json
```

## Sharing a pack (`.lumen`)

A `.lumen` file is a zip of one or more pack folders (the folder, not just its contents). In
Lumen: Settings → Lessons → Community lesson packs → "Save as .lumen" to export, "Install from a
file" or a GitHub link to install (a repository, a `tree/<branch>/<folder>` link, a `.lumen`
file in a repository, or a release download).

Install rules:

- Data only: `.json`, `.md`, `.txt`, `.png`, `.jpg`, `.jpeg`, `.webp` and `LICENSE` / `NOTICE`
  / `README`. Anything else (scripts, programs) fails the install. App bridges ship only with
  Lumen.
- At most 50 MB unpacked and 2000 files; no paths outside the pack, no symbolic links.
- Every pack must pass the validator above. Nothing is installed when one problem is found.
- A pack may not replace one that ships with Lumen, or a pack folder you made yourself.
- Installed packs live in `~/.ai-overlay/skills/<id>/` with a `.lumen-pack.json` marker and are
  **untrusted**: their lessons teach and check, but Lumen never does their steps for you.
