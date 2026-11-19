`openapi-3.0.json` is the OpenAPI document of dlm-server round 4 (v0.8.0): the capture body's `refreshTaskId`, tasks
with `archived`, and the `browser.not_a_page` problem on top of v0.7.5. To update, replace it with the release asset
`dlm_<version>_openapi-3.0.json` of a newer release and run `pnpm generate:api`; `pnpm check:api` (CI) fails when the
generated types do not match the spec.
