# COROS credentials in a MySQL table (plaintext for v1)

The Go stack is leaving Azure, so the Python pattern of keeping watch
credentials in Azure Key Vault does not carry over. Instead we store per-user
provider credentials in a MySQL `provider_credentials` table (PK
`(user_id, provider)`), which plays Key Vault's role as the central credential
store, read through a `CredentialStore` interface (MySQL backend primary; a
file/offline backend kept possible for tests). This deliberately diverges from
the AGENTS.md HARD rule "Auth tokens / secrets → Azure Key Vault".

## Consequences

- The `secret` blob holds password-equivalents: the COROS MD5 `pwd_hash` logs
  straight into COROS, and the `access_token` is a live bearer token.
- **For v1 the `secret` blob is stored plaintext** — a known, temporary
  downgrade from Key Vault's encryption-at-rest. Envelope-encrypting it
  (AES-GCM, key from `STRIDE_SYNC_CRED_KEY`) is a deferred follow-up and should
  land before this leaves local dev / touches real user credentials.
- `user_id` is always the **STRIDE UUID** (canonical-UUID guarded on write); the
  COROS account id lives in `provider_user_id` and is used only for COROS API
  headers.
