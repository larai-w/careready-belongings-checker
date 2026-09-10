# Contributing to CareReady

Contributions are welcome. Please read `README.md` and `AGENTS.md` first.

## Public-repo boundary (required)

- Do not commit strategy, business plans, raw pilot data, facility-identifying details, personal data, credentials, or sales information.
- Internal handover / growth notes belong in `larai-w/veai-private`, not this public repo.
- Do not weaken security/privacy checks.

## Before you start

- Confirm your change is small, focused, and reproducible.
- Open or reference an issue before larger behavior changes.
- For frontend behavior changes, prefer tiny reproducible diffs.

## How to contribute

### 1) Issues
- File issues with expected behavior, reproduction steps, and acceptance criteria.
- Bug reports should include environment, device/browser, and minimal repro steps.

### 2) Pull requests
1. Create a branch and keep scope narrow.
2. Update docs for user-visible changes.
3. Add/adjust tests or checks when possible.
4. Run validation checks listed below.

### 3) Required checks (before commit)
```bash
node --check app.js && node --check storage.js && node --check sw.js
python3 -c "import json; json.load(open('data.json'))"
python3 scripts/check_public_repo.py --staged
```

Also run any additional checks relevant to your change.

## Commit and PR

- Keep commit messages factual and neutral.
- PR should include what changed, why, and what you ran to verify.

## License

All contributions are licensed under the repository's license.
