# CareReady GitHub Project Operating Model

Last updated: 2026-07-19

## Purpose

GitHub Issues and Projects provide the live execution view for CareReady. Product context remains in version-controlled documents, while each active story, task, experiment, risk, and decision has a traceable GitHub item.

Project automation begins with the pilot-readiness phase. Earlier delivery is represented by historical commits and the links in [Product Management Case Study](13_product_management_case_study.md); it must not be presented as if those increments were managed in a Project board at the time.

## Project structure

The public [`CareReady Product Delivery`](https://github.com/users/larai-w/projects/2) Project is linked to the repository and uses these fields:

| Field | Values / format | Purpose |
|---|---|---|
| Status | Backlog, Ready, In progress, Done | Workflow state |
| Type | Story, Task, Experiment, Risk, Decision | Nature of work |
| Priority | P0, P1, P2 | Value and urgency |
| Area | Family, Facility, Content, Backend, Security, Offline, Delivery, Pilot | Product boundary |
| Release Gate | M1 Safety, M2 Pilot, M3 Revision, M4 Beta, M5 Public | Release gate |
| Target date | Date | Time-boxed commitments only |
| Evidence | Text or link | PR, test, feedback, or decision record |

Recommended views:

- `Delivery board`: grouped by Status, filtered to Story and Task.
- `Pilot evidence`: Experiment and Decision items grouped by Milestone.
- `Risks`: open Risk items sorted by Priority.
- `Roadmap`: items with target dates grouped by Milestone.
- `Done with evidence`: completed items showing Evidence and linked PRs.

## Workflow policies

### Definition of ready

An item can move to `Ready` when:

- the user or operational outcome is clear;
- acceptance criteria or decision signals are testable;
- privacy, safety, accessibility, and offline constraints have been considered;
- dependencies and deliberately excluded scope are visible;
- the evidence needed to close the item is known.

### Definition of done

A delivery item can move to `Done` when:

- acceptance criteria are met;
- relevant automated checks pass;
- manual evidence is attached where automation is insufficient;
- documentation and operational assumptions are updated;
- the PR links and closes the issue;
- release status is described accurately.

An experiment is done only when its result and resulting decision are recorded. Running an interview is activity, not an outcome.

## Traceability convention

```text
Product objective
  -> User story or risk
  -> Delivery task or experiment
  -> Pull request / operational evidence
  -> Verification
  -> Decision and roadmap update
```

PR descriptions must link the relevant Issue and use `Closes #N` only when all acceptance criteria are met. Commits should use concise outcome-oriented messages; the PR holds the full verification record.

## Automation

The Project uses GitHub's built-in workflows rather than a repository Action with a long-lived personal access token. `Auto-add to project`, `Item added to project`, `Item closed`, `Auto-close issue`, `Pull request linked to issue`, and `Pull request merged` are enabled. This keeps Project write authority out of repository secrets and prevents a second automation path from creating ambiguous behaviour.

The repository is linked to the Project, and `PROJECT_URL` records the canonical board URL for future integrations. Labels cover item type (`user-story`, `task`, `experiment`, `risk`, `decision`), priority (`priority:p0`, `priority:p1`, `priority:p2`), and honest historical classification (`evidence:retrospective`). CI and deployment remain independent of Project configuration.

When changing Project workflow filters, verify the result with one non-sensitive test Issue and remove the test item afterward. Never store GitHub tokens in Issues, Project fields, documentation, or source control.

## Initial live backlog

These issues are the current live backlog, not historical backfill:

| Type | Title | Priority | Milestone |
|---|---|---|---|
| Task | [#6 Complete real-device facility-to-family E2E walkthrough](https://github.com/larai-w/careready-belongings-checker/issues/6) | P0 | M1 Safety |
| Risk | [#7 Rotate pilot credentials and verify recovery runbook](https://github.com/larai-w/careready-belongings-checker/issues/7) | P0 | M1 Safety |
| Experiment | [#8 Validate the 34-item baseline with care staff and families](https://github.com/larai-w/careready-belongings-checker/issues/8) | P1 | M2 Pilot |
| Experiment | [#9 Observe two complete preparation and return cycles](https://github.com/larai-w/careready-belongings-checker/issues/9) | P1 | M2 Pilot |
| Experiment | [#10 Test whether facility-code handover fits real practice](https://github.com/larai-w/careready-belongings-checker/issues/10) | P1 | M2 Pilot |
| Decision | [#12 Select B-4 sync, B-5 dashboard, or neither from pilot evidence](https://github.com/larai-w/careready-belongings-checker/issues/12) | P2 | M3 Revision |
| Task | [#11 Define support, privacy, rollback, and incident contacts](https://github.com/larai-w/careready-belongings-checker/issues/11) | P1 | M3 Revision |

Issues [#1](https://github.com/larai-w/careready-belongings-checker/issues/1) and [#2](https://github.com/larai-w/careready-belongings-checker/issues/2) are closed historical evidence. Their comments explicitly identify the mapping as retrospective; they do not imply that the Project existed during those increments.

## Agile claim to use publicly

Use:

> I managed CareReady as an evidence-driven, agile product: user stories and acceptance criteria shaped increments; GitHub Issues and Projects track current work; PRs and CI provide delivery evidence; and release gates require operational and user validation.

Avoid:

- claiming Scrum ceremonies, team velocity, or servant leadership without a team;
- treating issue count or story points as product outcomes;
- presenting reconstructed historical Issues as contemporaneous records;
- including participant names, facility identities, or health information in public Issues;
- claiming clinical validation or reduced care incidents before evidence exists.
