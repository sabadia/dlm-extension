`openapi-3.0.json` is the release asset `dlm_0.6.0_openapi-3.0.json` of dlm-server v0.6.0 (it has the pairing API, the
`extension` token scope and the capture additions of Phase 14). To update, replace it with the asset of a newer
release and run `pnpm generate:api`; `pnpm check:api` (CI) fails when the generated types do not match the spec.
