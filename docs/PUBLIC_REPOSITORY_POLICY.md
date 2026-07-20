# Public Repository Policy

CareReady is a public portfolio repository. Source code, sanitised architecture documentation, test evidence, and deliberately public product-management evidence may be tracked.

The following material must remain outside Git:

- strategy, pricing, sales, fundraising, and unpublished positioning notes;
- working handover notes and unpublished content drafts;
- raw pilot observations, interview notes, participant details, and facility-identifying information;
- credentials, recovery material, access codes, personal data, and non-public operational details;
- any document explicitly classified for private use.

Store private working material under `.private/` or another ignored path. Publish a separately written, sanitised summary only when its audience and disclosure scope have been reviewed.

## Enforcement

- `.gitignore` excludes private directories, naming conventions, and known local-only documents.
- `.githooks/pre-commit` rejects staged private paths, classification markers, and common credential formats.
- CI runs the same policy against every tracked file.
- `AGENTS.md` requires every coding agent to preserve this boundary and prohibits bypassing the check.

Run `python3 scripts/check_public_repo.py --staged` before committing. A rejected file must be removed from staging or rewritten as a sanitised public document; the checker must not be bypassed.
