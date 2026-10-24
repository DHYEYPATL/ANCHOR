# Security policy

Anchor stores private personal records. Treat this repository as a security-sensitive prototype, not as a certified or security-audited product.

## Reporting a vulnerability

Do not publish exploit details, real records, pairing bundles, tokens, passphrases, or private user data in a public issue. If this project is hosted on a platform with private vulnerability reporting, use that private channel. Otherwise, contact the project maintainer through a private channel agreed with the maintainer and provide a minimal reproducible report.

Please include the affected component/version, prerequisites, impact, exact reproduction steps using synthetic data, and a proposed mitigation if you have one. Allow time for investigation and a fix before public disclosure.

## Safe testing

- Use synthetic records and disposable vaults only.
- Do not point tests at a real user's relay or profile.
- Never attach a plaintext export, pairing bundle, encrypted backup, access token, or vault file to an issue.
- Run relay tests against isolated local storage.
- Report uncertainty honestly; a passing test suite is not proof that the cryptographic design or full product is secure.

## Current release status

The repository still requires independent cryptographic and application security review, a reproducible frontend dependency lockfile, per-device credentials and revocation, production relay controls, end-to-end browser/device tests, and a documented recovery drill before use with sensitive real-world data.
