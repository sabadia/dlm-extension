# Spikes (E0.5 to E0.9)

Time-boxed measurements with real software, before the design depends on a guess. The code that produced them is in
`spikes/` (a small collector server, a plain extension for both browsers, and a runner); raw results are in
`spikes/results/*.json`.

| Spike                                              | Result in one line                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [E0.5](e0-5.md) Loopback fetch from the background | Works in Chrome and Firefox with host access; no prompt, no preflight. No fallback transport needed. |
| [E0.6](e0-6.md) Origin checks                      | The daemon accepts extension requests as they are. **P14.2 is not needed.**                          |
| [E0.7](e0-7.md) Download hand-off                  | Cancel and erase on `downloads.onCreated` works the same in both browsers and leaves nothing behind. |
| [E0.8](e0-8.md) Service-worker lifetime            | About 30 s idle; an open fetch stream does not help; a 30 s alarm or a native port does.             |
| [E0.9](e0-9.md) Ids and permissions                | Chrome id and Firefox id fixed; Firefox needs top-level listeners.                                   |

## How to repeat them

```sh
export SPIKE_TMP=/tmp   # scratch space
export CHROME="/path/to/Google Chrome for Testing"   # branded Chrome refuses --load-extension
export FIREFOX=/path/to/Firefox.app
node spikes/run.mjs chrome api
node spikes/run.mjs chrome downloads --action=cancel
node spikes/run.mjs chrome lifetime --phase=alarms --seconds=130
node spikes/run.mjs firefox downloads --nogrant --action=block
```

Needs `dlm` on the `PATH` (these ran against v0.5.0). The runner starts its own daemon in a temporary home, so nothing
touches a real DLM installation or a real browser profile.

## What was used

Chrome for Testing 156.0.8078.73 (same build line as Chrome 156.0.8078.74, which ignores `--load-extension`), headless
and headful; Firefox 159.0 through `web-ext run` (headless); `dlm` 0.5.0; macOS on Apple silicon. Windows and Linux
are covered by CI later and by the manual checklists (E7.6).
