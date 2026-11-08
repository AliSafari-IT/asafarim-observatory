# Observatory contribution rules

- Read the workspace hub instructions and notes before work.
- Before implementation, create or select an open issue in this repository. State the problem, scope, acceptance criteria, dependencies and validation. Clarify material architecture decisions before coding.
- Use an issue-numbered branch from main. Keep each PR focused and include `Closes #<issue>` in its body. The issue must exist before the PR; a pull request is not an originating issue.
- Keep durable architecture, ADRs, plans and production runbooks in the private `asafarim-docs/ventures/asafarim-observatory/` handbook. Link the relevant document path from the issue/PR; keep source and tests here.
- Follow the affected component's conventions. Use Node 24 and pinned pnpm. Run `sh scripts/check.sh` with Go installed; for gateway/dashboard work run `pnpm check`, `pnpm test`, `pnpm test:env`, `pnpm test:gateway`, `pnpm test:workflow` and `pnpm build`. Test meaningful permission, failure and storage boundaries.
- Bump affected application versions before release and keep displayed versions consistent. Record validation, material limitations, migrations, configuration needs and rollback considerations in the PR.
- Merge only with green CI. Do not push directly to main. Verify the deployed revision, health, HTTPS and intended access after an authorized deployment. Distinguish automated checks from user acceptance still needed.
- Never commit credentials, private age identities, plaintext environments, user/request data or raw production responses. Store runtime state outside the image and consult the handbook before environment changes.
- Historical issues for PRs #1–10 are explicitly retrospective. Do not describe them as original plans or copy that practice for new work.
