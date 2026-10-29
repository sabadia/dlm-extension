# dlm-extension: agent instructions

- Spec: `docs/PLAN.md` is authoritative. Conventions: `docs/CONVENTIONS.md` (mandatory). Decisions: `docs/adr/`.
- Intent records: this repository uses intentline, see the block in `AGENTS.md` and `.claude/skills/intentline/SKILL.md`.
- The daemon and the app live in `sabadia/dlm-server` (P14.x issues) and `sabadia/dlm-app` (F9.x issues). If a task needs
  something they cannot do yet, it depends on those issues. Do not work around it here.

@AGENTS.md
