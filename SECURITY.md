# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/sabadia/dlm-extension/security/advisories/new)
rather than a public issue. Include the extension and DLM versions, the browser and operating system, and steps to
reproduce. You can expect an answer within a week.

## Scope

The extension holds a scoped token for your DLM server, reads cookies and request headers of downloads it hands to
DLM, and talks to the DLM app through Native Messaging. Reports about token storage, what a web page can make the
extension do, cookie handling, permissions, and the pairing flow are especially welcome.

Only the latest release is supported with fixes.
