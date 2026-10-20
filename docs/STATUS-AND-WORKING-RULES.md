# STATUS AND WORKING RULES

## Status
- Milestone 1 (Foundation) is accepted, subject to `npm test` and `npm run typecheck` passing on the owner's machine. It delivered: npm-workspaces TypeScript monorepo skeleton, shared domain vocabulary, validated per-farm settings schema with the approved defaults (weights in integer tenths of kg, money in integer minor units, ratios in basis points, mock SMS by default), unit tests for settings, docs/TEST-PLAN.md, and .env.example.
- NEXT: Milestone 2 (database, events, sync). Do not redo Milestone 1.

## Working autonomously
Work through Milestones 2 to 6 without waiting for approval between milestones.

- Follow 01-PROJECT-BRIEF.md and 02-DECISIONS.md. If something is unclear, choose the safest option consistent with the brief, record it in docs/DECISIONS.md (what, why, the alternative), and continue. Only stop to ask if you need credentials, a real device, or the choice could lose data or change how money is calculated.
- Never weaken, skip or delete a failing test to make it pass. Fix the code, or record in DECISIONS.md why the spec is wrong.
- Keep all three surfaces in the design: supervisor PWA, SMS to the Owner and workers, Admin web dashboard. Do not build the dashboard before Milestone 7.

## Milestone 2 notes
- Add packages/database with PostgreSQL migrations and a docker-compose for local Postgres. Tests must run against a real test database, not mocks.
- Events are append-only with client-generated UUID v7 ids. Push is idempotent by event_id, pull is by cursor, and sync resumes safely if interrupted.
- The server is authoritative for lock state: late events for a locked week are stored and flagged as correction requests, never silently applied.
- Same worker/same day conflicts are surfaced, never silently resolved.
- Include farms, users, devices and enrolment tables, with Admin-issued device enrolment and revocation.
- No UI work in this milestone.

## Git
- Commit small and often. One branch per milestone (m2-events-sync, m3-rules, and so on). Merge to main only when typecheck and ALL tests pass. Tag each milestone (v0.2-m2, etc.).
- Never commit secrets. Keep .gitignore (node_modules, .env, build output) and .env.example up to date.

## At the end of each milestone
Update the README, run the full test suite, and write docs/MILESTONE-N.md with: what was done, exact test counts, run commands, "Deviations and things I did not do", and open questions.

## Mandatory stops (everything else, keep going)
1. After Milestone 3: stop with the summary, so the sync and pay rules can be reviewed before the PWA depends on them.
2. After building Milestone 4: stop and give a step-by-step real-device test script (install, airplane mode, log a day, reconnect, sync) for the supervisor's phone.
3. During Milestone 5: build everything against the mock SMS adapter, then stop and state exactly which live Africa's Talking settings are needed.
4. After Milestone 6: stop with a payroll walkthrough on the seed dataset (a worker with a rehire, a no-plucking day, a rate change and a mid-week firing), showing each calculation by hand and the app's result side by side.
