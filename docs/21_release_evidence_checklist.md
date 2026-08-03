# Release evidence checklist

CareReadyの技術的な完了と、サービスとしての準備完了を混同しないための公開用チェックリスト。

## Automated evidence

ローカルでは`bash scripts/run_human_gate_preflight.sh`で、deploy workflowとPython dependency auditを除く項目を一括確認する。GitHub側のSecurity baselineとDeploy結果は別途確認する。

- [ ] Public repository boundary passes
- [ ] JavaScript/JSON syntax passes
- [ ] Product content and product contracts pass
- [ ] Accessibility contracts pass
- [ ] Backend tests pass
- [ ] Headless smoke and E2E pass
- [ ] Full-history gitleaks scan passes
- [ ] Python dependency audit passes
- [ ] Deployment workflow passes

## Human evidence

- [ ] Physical-device flow reviewed
- [ ] Facility-code handover observed in practice
- [ ] Content and facility-rule wording reviewed by an appropriate human
- [ ] Support and recovery path understood by the operator
- [ ] Repeat-use signal collected without publishing personal or facility data

Automated evidence can support a release decision but cannot mark the human section complete. Record only anonymised, non-sensitive outcomes in public Issues and Projects.
