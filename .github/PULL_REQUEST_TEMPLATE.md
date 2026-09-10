## Outcome

What user, product, operational, or quality outcome does this change support?

## Link / Context

- Story / task / experiment:
- Decision or risk:
- Use `Closes #<issue>` when this PR completes an issue.

## Scope

- In scope:
- Deliberately excluded:

## Verification

- [ ] `node --check app.js && node --check storage.js && node --check sw.js && node --check admin/admin.js`
- [ ] `python3 -c "import json; json.load(open('data.json'))"`
- [ ] `python3 scripts/check_public_repo.py --staged`
- [ ] Backend tests were run when backend behaviour changed
- [ ] Headless UI checks were run when family UI changed
- [ ] Manual evidence recorded when automation is insufficient
- [ ] `sw.js` cache version handling reviewed when frontend files changed

## Risk and release notes

- Privacy / security impact:
- Offline impact:
- Accessibility impact:
- Rollback or containment:

## Evidence

Screenshots, test output, anonymised notes, or links to documentation:
