# Product decision evidence matrix

This matrix supports Issue [#12](https://github.com/larai-w/careready-belongings-checker/issues/12). It is a decision aid, not a commitment to build synchronisation or a facility dashboard.

## Options

| Option | User problem addressed | New data exposure | Delivery/support cost | Evidence required before selection |
|---|---|---|---|---|
| B-4: family synchronisation | Family members continue preparation across devices | High: account, identity, cross-device state | High | Repeated cross-device need and explicit consent expectation |
| B-5: facility progress dashboard | Staff see preparation status before arrival | High: facility-facing progress and access control | High | Repeated operational need and defined staff access boundary |
| Extend facility templates | Facility rules are clearer without progress tracking | Medium: more template content, no family account required | Medium | Specific recurring template gaps and manageable support load |
| Improve current local-first flow | Reduce confusion without adding shared data | Low | Low | Repeated usability issue that can be solved in the current flow |

## Evidence log

| Signal ID | Source type | Anonymised finding | Supports | Weakens | Confidence |
|---|---|---|---|---|---|
| `SIG-___` | `Issue #10` / support / usability review | One sentence, no personal or facility details | `B-4` / `B-5` / template / current flow | Option name | `low` / `medium` / `high` |

Minimum decision gate: two comparable signals, one privacy/support impact review, and a written record of rejected options. Do not use product behaviour analytics as a substitute for human evidence.

## Decision record

- Selected option: `not decided`
- Rejected options and reasons: `not decided`
- Release gate update needed: `yes` / `no`
- Decision owner confirmation: required before implementation
