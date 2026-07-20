## Outcome

What user, product, operational, or quality outcome does this change support?

## Traceability

- Story / task / experiment:
- Decision or risk:
- Use `Closes #<issue>` when this PR completes an issue.

## Scope

- Included:
- Deliberately excluded:

## Verification

- [ ] `node --check app.js && node --check storage.js && node --check sw.js && node --check admin/admin.js`
- [ ] `python3 -c "import json; json.load(open('data.json'))"`
- [ ] Backend tests when backend behaviour changes
- [ ] Headless Chrome smoke test when the family UI changes
- [ ] Manual evidence recorded for behaviour automation cannot verify
- [ ] `sw.js` cache version bumped when frontend files change

## Risk and release notes

- Privacy / security impact:
- Offline impact:
- Accessibility impact:
- Rollback or containment:

## Evidence

Screenshots, test output, anonymised pilot notes, or links to relevant documentation:
