# careready-belongings-checker
AWS Serverless belongings checker designed for Parkinson's Disease patients during facility transfers to aid caregivers.

### CareReady // MVP Phase 2 // Memory & Tailoring Functions

This update integrates critical user feedback from caregivers (stakeholders) to enhance usability and provide better project control (Tailoring). This project demonstrates PMP skills in integration and stakeholder management.

#### Key Functional Primitives (Features)
* [x] **Checkbox State Memory:** Primitives for checkbox states are persisted across page refreshes using localStorage.
* [x] **'Not Needed' Toggle per Item:** Each item can be toggled as 'Not Needed', which are then greyed out and excluded from the total count in the progress bar. This allows situation-based tailoring of deliverables.
* [x] **Container (Box) Management & Sorting:** A dropdown for box selection (Box 1-4, None, etc.) is added to each item, and states are persisted. A 'Sort by Container' view is implemented, grouping items by box and showing count. This enhances integration control for caregivers.

#### Acceptance Criteria

The following deliverables are verified as complete. This demonstrates PMP quality management skills.
* [x] Checkbox states are persisted across page refreshes.
* [x] Items can be toggled as 'Not Needed', which are then greyed out and excluded from the progress bar.
* [x] A dropdown for box selection (Box 1-4, None, etc.) is added to each item, and states are persisted.
* [x] A 'Sort by Container' view is implemented, grouping items by box and showing count.
* [x] The URL is cleaned using CloudFront Functions for `https://veai.jp/ready/index.html` to `https://veai.jp/ready/`. This demonstrates AWS Serverless primitives skills (MSCS).

This demonstrates PM skills in defining functional primitives and MSCS skills in delivering secure, data-driven solutions through agile development.
