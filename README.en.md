# dsh-persona

[![verify](https://github.com/TBAOT/dsh-persona/actions/workflows/verify.yml/badge.svg)](https://github.com/TBAOT/dsh-persona/actions/workflows/verify.yml)

Long-term memory for DeepSeek Harness, organised the way Hermes does it: two
tiers per persona, frozen into the prompt at session start, plus a per-turn
review that records what it learned without being asked.

## Install

> The name `dsh-persona` on npm belongs to someone else (a placeholder `0.0.1`).
> This repository is not published to npm — install it from git.

```sh
dsh plugin --profile <profile> add github:TBAOT/dsh-persona
```

Then add `dsh-persona` to the profile's bundle list and restart the Harness.

## What it gives you

- **Two memory tiers per persona** — `user` (who you are, how you want to be
  answered) and `memory` (the persona's own notes). Each has a hard character
  budget; an over-budget write is refused with the exact deficit, so the agent
  consolidates instead of silently losing entries.
- **Frozen prompt snapshot** — memory is read once when a session starts and
  never rewritten mid-session, which keeps the provider's prefix cache valid.
  Writes land on disk immediately and appear in the next session.
- **Automatic per-turn review** — after a turn settles, one model call reads a
  digest plus the current memory and returns structured edits. Nothing is
  written if the model finds nothing worth keeping, and every run is recorded.
- **Persona isolation by workspace** — a persona owns one or more workspace
  directories; sessions opened there use that persona's memory. One persona,
  many projects, one shared memory.
- **Private skills** — skills dropped into `personas/<id>/skills/` are indexed
  only for that persona's prompt. Shared skills keep living in the global roots.
- **Audit ledger** — every review run is listed with its status, duration,
  model, and the exact entries it added, changed or removed.

## Where the data lives

```
<DSH_HOME>/personas/
  index.json                 personas, workspace bindings, per-tier limits
  <persona>/memory/user.md   user profile      (default 1375 chars)
  <persona>/memory/memory.md persona notes      (default 2200 chars)
  <persona>/skills/          private skills
  <persona>/review/log.jsonl one line per review run
```

Everything is plain Markdown/JSONL: readable, diffable, and safe to back up.

## Panel

A sidebar entry named "角色" opens the panel:

- persona index with slot numbers, create / rename / delete
- two memory editors with a character ruler (turns red past 90%)
- review ledger with filters and expandable entries
- workspace binding per persona
- per-persona character limits (200–20000)

## Configuration

```yaml
- id: persona-memory
  name: dsh-persona
  config:
    personaId: default     # fallback persona when no workspace is bound
- id: persona-review
  name: dsh-persona/review
  config:
    enabled: true
    everyTurns: 1
    maxTokens: 1200
    dryRun: false          # true = record what it would write, write nothing
    provider: wb-proxy     # optional; defaults to the platform default model
    model: deepseek-v4.1-flash
```

## Privacy

- Memory is local plain text; nothing is uploaded by the plugin itself.
- The only text leaving the machine is what the model provider receives with a
  normal request, including the injected memory block.
- The review sends a conversation digest to the model you configured.

## Uninstall

Remove the bundle from the profile. Files under `<DSH_HOME>/personas/` are kept
so you can migrate or delete them yourself.

## License

MIT
