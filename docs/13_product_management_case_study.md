# CareReady Product Management Case Study

Last updated: 2026-08-02

## Executive summary

CareReady is an in-development health-adjacent product for belongings preparation across family and care-facility handovers. It began as a browser checklist and evolved into an offline-first family workflow plus an authenticated facility template service.

This case study documents the product-management evidence behind that evolution. It distinguishes delivered software from validated outcomes: the core loop works in production, while broader service readiness still depends on real-device verification, closed pilots, content review, and repeat use.

## Product problem and stakeholders

The product problem is not simply "people forget items." Information comes from different owners and changes at different rates:

- Families know the person's routines, preferences, aids, and previous packing decisions.
- Facilities define local requirements, supplied items, restrictions, and handover instructions.
- The product provides a reusable baseline and a workflow for outbound and return checks.

Primary stakeholders are family caregivers, facility staff, and the person receiving care. Secondary stakeholders include care managers, support contacts, and the product operator responsible for privacy, availability, and support.

## Product-management approach

CareReady uses an evidence-driven, agile delivery model suitable for a solo, AI-assisted product. It does not claim to reproduce a full Scrum team. The management system uses:

- a product definition and phased roadmap;
- epics, user stories, acceptance criteria, and explicit priorities;
- architecture and content boundaries tied to stakeholder ownership;
- small production increments with automated quality gates;
- release gates that include operational and user evidence, not code completion alone;
- a closed-pilot plan with hypotheses, interview prompts, stop conditions, and decision rules;
- documented deferral of features that do not yet have supporting evidence.

The current operating model is described in [GitHub Project Operating Model](14_github_project_operating_model.md). The original discovery backlog remains in [User Stories](04_ユーザーストーリー.md).

## How the product changed through learning

| Initial framing | Evidence or constraint | Product decision | Delivery evidence |
|---|---|---|---|
| A static checklist is sufficient | Families need state to survive refreshes and weak connectivity | Offline-first PWA with IndexedDB persistence and bundled fallback data | [`c1b0193`](https://github.com/larai-w/careready-belongings-checker/commit/c1b0193) |
| One standard list can represent the workflow | Product defaults, facility rules, and personal needs have different owners | Three-layer merge: product + facility + personal | [Content architecture](08_持ち物コンテンツ設計_アーキテクチャ.md), [`2560898`](https://github.com/larai-w/careready-belongings-checker/commit/2560898) |
| Packing ends at departure | Returned belongings and consumables behave differently | Return-check mode, consumable exclusion, and inquiry-message output | [`d4564b9`](https://github.com/larai-w/careready-belongings-checker/commit/d4564b9) |
| A shared URL is enough | Facilities need controlled authorship without forcing family registration | Authenticated facility administration plus narrow public code redemption | [`18d1f9e`](https://github.com/larai-w/careready-belongings-checker/commit/18d1f9e), [`e12aea0`](https://github.com/larai-w/careready-belongings-checker/commit/e12aea0), [`2560898`](https://github.com/larai-w/careready-belongings-checker/commit/2560898) |
| Working software means release-ready | Care content, staff workflow, support, privacy, and repeat use require human evidence | Closed pilot before broad public calls to action | Public Project release gates and anonymised validation evidence |
| More features demonstrate progress | Sync, dashboards, and AI increase risk and support load before the operating model is validated | Defer major scope until pilot evidence selects it | Public Project decisions and linked Issues |

## Backlog and traceability

The initial backlog is organised into four epics: prepare, create a list, share, and reuse. This table provides a concise audit trail from need to delivery.

| Story | User outcome | Current status | Evidence |
|---|---|---|---|
| US-1.1 | Persist checklist progress and exclude items not needed | Delivered; pilot validation pending | [`c1b0193`](https://github.com/larai-w/careready-belongings-checker/commit/c1b0193), source-policy CI in [`3fc49a5`](https://github.com/larai-w/careready-belongings-checker/commit/3fc49a5) |
| US-1.2 | Record which container holds each item | Delivered; pilot validation pending | [`6a21757`](https://github.com/larai-w/careready-belongings-checker/commit/6a21757) |
| US-1.3 | Confirm that non-consumable items returned home | Delivered; pilot validation pending | [`d4564b9`](https://github.com/larai-w/careready-belongings-checker/commit/d4564b9) |
| US-2.1 | Start from a template and personalise it | Delivered for bundled and facility templates; content validation pending | [`6a21757`](https://github.com/larai-w/careready-belongings-checker/commit/6a21757), [`2560898`](https://github.com/larai-w/careready-belongings-checker/commit/2560898) |
| US-3.1 | Share work across family members | URL template sharing delivered; authenticated cross-device collaboration deferred | [`6a21757`](https://github.com/larai-w/careready-belongings-checker/commit/6a21757), [backend design](06_バックエンド設計書.md) |
| US-3.3 | Let a facility distribute its official template | Core create-and-redeem loop delivered; uptake analytics deferred | [`e12aea0`](https://github.com/larai-w/careready-belongings-checker/commit/e12aea0), [`2560898`](https://github.com/larai-w/careready-belongings-checker/commit/2560898) |
| US-1.4 | Make personal belongings easy to spot | Delivered for custom items; human validation pending | [`9bbab74`](https://github.com/larai-w/careready-belongings-checker/commit/9bbab74) |
| US-2.4 | Prepare for a special outing without mixing core destinations | Prototype and automated contract/E2E coverage delivered; human validation pending | [`dc8d0bd`](https://github.com/larai-w/careready-belongings-checker/commit/dc8d0bd), [`e25d76e`](https://github.com/larai-w/careready-belongings-checker/commit/e25d76e) |
| US-4.1 | Reuse previous preparation decisions | Local reuse delivered; behaviour validation pending | [`c1b0193`](https://github.com/larai-w/careready-belongings-checker/commit/c1b0193) |

"Delivered" means implemented and technically verified. It does not mean that a user or care outcome has been proven.

## Prioritisation and scope control

Priorities changed when the riskiest assumptions changed. Early work reduced technical failure modes: persistence, offline access, XSS-safe rendering, and deployment consistency. The next increments addressed workflow completeness: custom items, containers, return checking, and facility templates. Once the production core loop worked, the priority moved from feature throughput to validation.

The following features are intentionally outside the current release gate:

- family login and cross-device synchronisation;
- facility preparation-progress dashboards;
- AI-generated belongings recommendations;
- broad expansion into travel, childcare, or disaster packing.

They enter delivery only if pilot evidence shows that the current workflow cannot create repeat value without them. This is a scope-management decision, not an implementation limitation.

## Risk and quality management

| Risk | Management response | Evidence |
|---|---|---|
| Personal state disappears or becomes unavailable | IndexedDB persistence, local fallback, offline shell, migration path | `storage.js`, `sw.js`, CI smoke test |
| Dynamic content creates an XSS path | DOM creation with `textContent`; automated source-policy validation | `scripts/validate_source_policy.py` |
| A stale service worker hides a release | Cache-version change required for frontend modifications | `scripts/validate_source_policy.py` |
| Facility templates are modified without authority | Cognito staff authentication and JWT-protected CRUD routes | `backend/infra/`, `backend/src/handler.py` |
| Facility or medical instructions are treated as product defaults | Three-layer content ownership and explicit professional-instruction precedence | [Content architecture](08_持ち物コンテンツ設計_アーキテクチャ.md) |
| Engineering completion is mistaken for service readiness | Explicit Project release gates and documented acceptance evidence | [GitHub Project operating model](14_github_project_operating_model.md) |
| AI-assisted delivery introduces unreviewed changes | Repository rules, human approval for deployment, automated checks, public limitations | `AGENTS.md`, `.github/workflows/ci.yml` |

## Delivery and quality evidence

The delivery pipeline verifies JavaScript syntax, JSON validity, product content, frontend source policies, nine backend test cases, and a headless-browser rendering threshold. Main-branch changes deploy static assets to S3 and invalidate CloudFront.

Relevant increments include:

- Phase 0 foundation: [`c1b0193`](https://github.com/larai-w/careready-belongings-checker/commit/c1b0193)
- Personalisation and sharing: [`6a21757`](https://github.com/larai-w/careready-belongings-checker/commit/6a21757)
- Return checking: [`d4564b9`](https://github.com/larai-w/careready-belongings-checker/commit/d4564b9)
- CI/CD: [`0d7914d`](https://github.com/larai-w/careready-belongings-checker/commit/0d7914d)
- Backend and infrastructure: [`e12aea0`](https://github.com/larai-w/careready-belongings-checker/commit/e12aea0)
- Facility-to-family core loop: [`2560898`](https://github.com/larai-w/careready-belongings-checker/commit/2560898)
- Release-readiness quality gates: [`3fc49a5`](https://github.com/larai-w/careready-belongings-checker/commit/3fc49a5)
- Personal-item marker and outing-flow verification: [`9bbab74`](https://github.com/larai-w/careready-belongings-checker/commit/9bbab74), [`e25d76e`](https://github.com/larai-w/careready-belongings-checker/commit/e25d76e)
- Security automation and reviewable Project audit tooling: [`7bc28ac`](https://github.com/larai-w/careready-belongings-checker/commit/7bc28ac), [`351bc36`](https://github.com/larai-w/careready-belongings-checker/commit/351bc36)
- Reviewable release-readiness PR: [PR #4](https://github.com/larai-w/careready-belongings-checker/pull/4)

## Technical product-management depth

The product decisions are represented in working architecture, not only roadmap language:

- the no-login family journey maps to a static PWA, service worker, IndexedDB, and local fallback;
- the facility authorship boundary maps to Cognito, JWT-authorised API Gateway routes, and identity-derived DynamoDB keys;
- the family handover maps to a narrow public redeem route and a share-code GSI access pattern;
- the three content owners map to a client-side merge of bundled defaults, facility overrides, and personal state;
- the deployment model maps to CDK, automated backend tests, S3, CloudFront, and service-worker cache controls.

This allows the portfolio to show cloud and architecture literacy in product terms: user friction, trust, privacy, availability, cost, operability, and future-option trade-offs.

## Research discipline

The M2 pilot is product discovery, not a clinical study. Its value for research readiness is methodological rather than academic status:

- hypotheses and decision signals are written before observation;
- participant roles and contexts are recorded without publishing identities or health information;
- repeat behaviour is preferred over stated enthusiasm;
- supporting, weakening, and stop evidence are all retained;
- limitations and unvalidated outcomes remain visible;
- findings lead to an explicit roadmap decision rather than being used only as promotional quotes.

Any future academic use would require an appropriate research protocol, ethics review where applicable, consent, data governance, and a study design beyond this product pilot.

## Outcome evidence and limitations

Demonstrated outcomes:

- A production-deployed facility-to-family template loop exists.
- Families can use the core checklist without an account and continue after template retrieval without a network.
- Quality and policy checks run automatically in CI.
- Product scope, release gates, and deferred options are documented.

Not yet demonstrated:

- reduced forgotten-item incidents;
- reduced facility calls or staff time;
- repeat family use;
- willingness to pay;
- safe, low-support onboarding at broader scale.

Those claims require the M2 closed pilot. Results should be added as anonymised evidence, including negative findings and decisions not to proceed.

## Portfolio interpretation

This repository demonstrates product ownership across discovery, prioritisation, technical delivery, cloud architecture, risk management, and release governance. It is strongest evidence for a technical Product Owner or Product Manager role where the candidate must translate stakeholder needs into testable increments and work across APIs, cloud infrastructure, privacy, operations, and user experience.

It should not be presented as evidence of managing a multi-person Scrum team, a clinical product, or proven health outcomes. The accurate claim is: **CareReady is a solo, AI-assisted health-tech product managed through explicit user stories, evidence-based prioritisation, automated quality controls, and human release gates.**
