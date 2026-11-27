# Documentation

Map of every document, by what you want to do. The root [`README.md`](../README.md) gives the overview, how to bootstrap,
deploy and destroy; this page tells where each subject is explained in depth. Each track keeps its documents next to
its code and owns their accuracy.

## Start here

| I want to… | Read |
| --- | --- |
| Understand the whole system in one page | [`architecture.md`](architecture.md) (diagram), then the "at a glance" section of each track below |
| Deploy dev from scratch | [`../README.md`](../README.md) "Bootstrap a new environment", then [`infra.md`](infra.md) and [`reproducibility.md`](reproducibility.md) |
| Know who may do what, which secrets exist, what is public | the three security summaries below |
| Know why a third-party component is trusted | [`open-source.md`](open-source.md) |
| Prepare or run the defense | [`defense.md`](defense.md) |

## Infrastructure track (foundation, access, CI/CD)

| Document | Content |
| --- | --- |
| [`infra.md`](infra.md) | The four stacks, the foundation, the workflows, the design choices to defend; the map of the pages below |
| [`infra-security.md`](infra-security.md) | **Security summary**: people, pipeline identities, runners, secrets inventory, what is public |
| [`reproducibility.md`](reproducibility.md) | What a destroy removes and keeps, the procedure and the proof that nothing is left |
| [`ci/self-hosted-runners.md`](ci/self-hosted-runners.md), [`ci/runner-guardrails.md`](ci/runner-guardrails.md) | The runners on GKE (ARC) and which job may run on them |
| [`ci/branch-protection.md`](ci/branch-protection.md), [`ci/release.md`](ci/release.md), [`ci/security.md`](ci/security.md), [`ci/dependency-audit.md`](ci/dependency-audit.md) | Branch rules and `ci-gate`, releases, secret scanning and SAST, the `npm audit` exceptions |
| [`../infra/access/README.md`](../infra/access/README.md), [`../infra/billing/README.md`](../infra/billing/README.md) | Keyless authentication and roles of the pipeline, budgets |
| [`open-source-infra.md`](open-source-infra.md) | Third-party components of the track |
| [`hands-on-1-terraform.md`](hands-on-1-terraform.md) | The course exercise the foundation started from |

## Cloud functions track

| Document | Content |
| --- | --- |
| [`functions.md`](functions.md) | Layout, every function at a glance, design choices to defend, one section per worker, the identity of each function |
| [`discord-bot.md`](discord-bot.md) | The slash commands, their rules and answers |
| [`pubsub.md`](pubsub.md) | Topics, subscriptions, retries and dead-letter queues |
| [`data-model.md`](data-model.md) | Firestore collections, tiles and rasters, snapshots, security rules |
| [`observability.md`](observability.md) | Dashboards, logs and the queries to read them, traces, alerts |
| [`open-source-functions.md`](open-source-functions.md) | Third-party components of the track |

## Front track

| Document | Content |
| --- | --- |
| [`frontend.md`](frontend.md) | The web app and the Activity at a glance, how the browser talks to the cloud, design choices to defend |
| [`frontend-contract.md`](frontend-contract.md) | The contract between the front and the backend: login, tiles, real time, rejections |
| [`frontend-security.md`](frontend-security.md) | **Security summary** of the front: what the browser holds and reaches, what is deliberately public |
| [`discord-activity.md`](discord-activity.md) | Configuring the Discord application for the Activity (URL mappings, redirects) |
| [`../app/frontend/README.md`](../app/frontend/README.md) | Commands and code map of the app |
| [`open-source-frontend.md`](open-source-frontend.md) | Third-party components of the track |

## Defense

| Document | Content |
| --- | --- |
| [`defense.md`](defense.md) | Master runbook: order of the demo, who shows what, team checklist, rehearsal |
| [`defense-functions.md`](defense-functions.md), [`defense-front.md`](defense-front.md) | Detailed runbooks of the functions and front parts |
| `defense-infra.md` | Detailed runbook of the infra part (#83) |
| [`architecture.md`](architecture.md) | The architecture diagram and how it is produced |

## Keeping the documentation true

- A change that alters a documented behaviour updates the document in the same pull request.
- A new third-party dependency adds its row to the table of its track ([`open-source.md`](open-source.md) lists the
  commands that find the missing ones).
- A document that records a decision says whether it is settled; a "proposal" status is removed once the decision is
  made.
