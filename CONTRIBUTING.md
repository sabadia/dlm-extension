# Contributing

The plan in [docs/PLAN.md](docs/PLAN.md) is the authoritative specification; every piece of work is a task in it with
an issue on the [project board](https://github.com/orgs/sabadia/projects/5).

1. **One task, one issue.** A phase (a milestone) is one branch and one pull request; squash-merged with the pull
   request title as the commit message (Conventional Commits: `feat(intercept): ...`).
2. **Tick the task's checkbox in `docs/PLAN.md` only when its acceptance criteria are met.** Never change the plan to
   fit an implementation: if the plan is wrong or incomplete, open an issue saying why.
3. **Definition of done:** lint, typecheck and unit tests pass; works in Chrome **and** Firefox where the task
   applies; no token, cookie or credential can reach a log, an error or a page; docs updated; **all** CI checks green
   before merging.
4. **Backend and app needs.** If a task needs something the daemon or the app cannot do, it depends on a `P14.x`
   issue in [dlm-server](https://github.com/sabadia/dlm-server) or an `F9.x` issue in
   [dlm-app](https://github.com/sabadia/dlm-app). Do not work around it here.
5. **Never commit secrets** (signing keys, AMO keys, tokens). They live in GitHub Actions secrets only.
6. **Intent records.** A change of any size carries a short record of why it was made
   (`intentline capture --goal "..." --pending`); CI checks it. Affirming a record is for a human reviewer.

Read [docs/CONVENTIONS.md](docs/CONVENTIONS.md) before writing code.
