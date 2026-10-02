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

## Run it locally

CareReady is a static PWA — there is no build step. Start with the
[local development guide](README.md#local-development). `API_BASE` still points to
a deployed API; localhost alone does not isolate OCR, template redemption,
notifications, feedback or staff operations. Use synthetic inputs and an isolated
backend for those paths.

```bash
python3 -m http.server 8000 --bind 127.0.0.1  # open http://localhost:8000/
npm test                       # existing frontend logic checks
```

⚠️ **Serve it over HTTP. Do not open `index.html` with `file://`.**
The app registers a service worker (`sw.js`), and service workers are not
available on `file://`. The registration failure is caught and logged, so the
page still loads — but offline use and cache updates silently do nothing, and
you will be debugging the wrong thing.

`npm test` is what CI runs (`node --test tests/*.test.js`). It uses fixtures
only: **no real care records, no AWS calls.**

Backend (CDK/Lambda) setup is separate — see **Local Development** in
`README.md`.

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
