# ADR 0001: stack, and how the extension talks to DLM

Status: accepted (2026-10-30). Revisit after spike E0.5.

## Context
The extension must run on Chrome (MV3 service worker) and Firefox (MV3 event page), find and pair with a local daemon
that listens on a random loopback port, and optionally talk to remote daemons.

## Decision
- **WXT + TypeScript (strict) + Preact.** WXT targets both browsers from one codebase and builds the zips and the
  Firefox sources archive; Preact keeps popup and options small.
- **Local discovery and pairing through Native Messaging** (`dev.sabadia.dlm`, the `dlm native-host` shim). After
  pairing, the extension calls the daemon's REST API directly with a scoped token (`fetch`, SSE through a streaming
  `fetch`).
- **Remote servers** use a URL and a token entered by the user; HTTPS recommended.
- **One typed client**, generated from the pinned OpenAPI document of the daemon release this extension is built
  against.
- If a Chrome service worker cannot reach `127.0.0.1` (Local Network Access, spike E0.5), the native host proxies the
  requests; the client has a transport interface so this is a swap, not a rewrite.

## Consequences
- The daemon needs a pairing flow, a scoped token, extension-origin handling and a stable native host (Phase 14).
- The app needs a pairing dialog and a paired-extensions list (M9).
- Two transports to keep in step if the fallback is needed.
