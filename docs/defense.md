# Defense runbook

Subject 5.1 to 5.5, issue #79. The defense is remote on Microsoft Teams, at the slot booked on the intranet; the slot is
not extended for a setup problem. Each member must be able to explain **the whole system** (infrastructure and code),
with a working microphone, preferably a webcam, a stable connection and screen sharing. Using an AI assistant during
the defense is cheating (subject 5.5): none is open on the machine that presents.

This page is the **master**: the order of the demo, who shows what, the checklists that apply to the whole team and the
rehearsal protocol. The commands, expected outputs and explanations live in one runbook per track, so that each is
written by the person who knows the code and can be run by anyone else:

| Part | Runbook | Written by | Issue |
| --- | --- | --- | --- |
| Infrastructure: foundation, runners, pipeline, access | `defense-infra.md` | infra track | #83 |
| Cloud functions: commands, workers, queues, observability | [`defense-functions.md`](defense-functions.md) | functions track | #84 |
| Front: app on prd, edge security, front pipeline | [`defense-front.md`](defense-front.md) | front track | #85 |

Every runbook states its own prerequisites (what must be merged and deployed) and marks with `TODO(prd)` what is only
known once prd is deployed. Replace the marker during the rehearsal and delete it.

## Order of the demo

It follows the six points of subject 5.3. The times are the ones of the track runbooks; the total must fit the slot,
which is checked by the timed rehearsal (last section).

| # | Subject 5.3 asks | What we show | Detail |
| --- | --- | --- | --- |
| 1 | From the IDE to production: PR, review, merge, release tag, deploy dev then prd, signed commits | a real PR with its checks and review, the `dev` deploy, the release PR into `main`, the tag, the `prd` deploy behind its required reviewers, `git log --format='%h %G? %an %s'` showing `G` | front runbook §3 (≈ 2 min); pipeline table of [`infra.md`](infra.md); [`ci/release.md`](ci/release.md) |
| 2 | Self-hosted runners up and used | Actions → *Runners*, a job log naming a runner of the scale set, the pod appearing for the job and disappearing after it | infra runbook; [`ci/self-hosted-runners.md`](ci/self-hosted-runners.md) |
| 3 | The app live on **prd** | Discord commands (`/draw`, `/get`, `/snapshot`, `/admin …`), the web app and the Activity in real time, a large grid, the brush, the inspection of a pixel | functions runbook §1 (≈ 5 min), front runbook §1 (≈ 5 min) |
| 4 | Scaling | runner **nodes** added then removed, serverless instances and queue backlog on the dashboards, under the load test | functions runbook §2 (≈ 3 min); infra runbook (nodes); load test of #76 |
| 5 | Security: least privilege, private functions and buckets, secrets, HTTPS, WIF, Discord signature | a 401 on a bad Discord signature, no function callable without the gateway, private buckets and Firestore refusing a write, keyless CI with the isolation proof | functions runbook §3 (≈ 3 min), front runbook §2 (≈ 4 min), infra runbook; [`infra-security.md`](infra-security.md) |
| 6 | Monitoring, logs, traces, one alert | follow one correlation id from the Discord command to the Firestore write, then trigger one alert and show it arrive | functions runbook §4 (≈ 3 min), front runbook §4 (≈ 2 min); alerts of #75 |

Between the points, keep the architecture diagram ([`architecture.md`](architecture.md)) at hand: the jury evaluates
it, and it must match what is deployed.

## Who shows what

The rule of the issue: **at least one full rehearsal where each member presents a part they did not build**, because
each member must be able to explain all of it. The table below is the order proposed for the rehearsal; it is
confirmed (or changed) by the team before the first one, and the builder of a part is on call to answer, not to present.

| Part | Built by | Presents in the rehearsal (proposal) |
| --- | --- | --- |
| Infrastructure (1, 2, parts of 4 and 5) | Zeishy | Raphael-Clenet |
| Cloud functions (3 commands side, 4, 5, 6) | Quentintnrl | Zeishy |
| Front (3 web side, 5, pipeline of the front) | Raphael-Clenet | Quentintnrl |

For the real defense, the jury may ask any member about any part: the roles above only decide who drives the screen.

## Checklist for the whole team

Part-specific checks (certificate, endpoints, scripts that must say `ok`) are in the "Before the defense" table of each
runbook. This list is what is shared, to tick at D-7, D-1 and one hour before.

**Environment**

- [ ] The last release tag is deployed on **prd** and the `deploy` run is green, including the smoke tests.
- [ ] Both stacks of prd have `No changes` on a plan (`ci-terraform` comments the plan of both environments on each PR).
- [ ] The repository is **private** (the subject asks for it; check *Settings → General → Danger zone*). Instructor access
  is still granted ([`infra/access/README.md`](../infra/access/README.md), "Checks").
- [ ] Budgets and their alerts are active ([`infra/billing/README.md`](../infra/billing/README.md)); the current spend is
  known before the defense, not discovered during it.
- [ ] The self-hosted runners are up, `CI_RUNNER` points to them (and back to `ubuntu-latest` after any destroy of dev).
- [ ] The Discord applications (prd): interactions endpoint URL, OAuth2 redirect, Activity URL mappings and the slash
  commands registered (details in the functions and front runbooks).
- [ ] The canvas is not paused, the dead-letter queues are empty, something recognisable is drawn near the coordinates
  the demo uses.
- [ ] Dashboards, Logs Explorer and Cloud Trace of prd are open in tabs; the alert channel receives test messages.

**People**

- [ ] Each member tried microphone, webcam, connection and **screen sharing** (one window and a whole screen) on Teams,
  from the machine used for the defense.
- [ ] Two Discord accounts logged in, in two browser profiles, to show real time between two users.
- [ ] Every member can answer, without notes, the questions of their own track in "Design choices to defend"
  ([`infra.md`](infra.md), [`functions.md`](functions.md), [`frontend.md`](frontend.md)) **and** the main question of the
  other two.
- [ ] No notification, chat or AI assistant visible on a shared screen. Secrets (Discord client secret, tokens) are never
  shown: blur or revoke afterwards.

## If something breaks during the defense

The same application runs on **dev** (every merge deploys it), with the same pipeline and the same dashboards. Say what
is happening, switch, and keep the narrative going.

| What fails | Do this |
| --- | --- |
| A prd step shows nothing | find the request by its correlation id (functions runbook §4) to say where it stopped; then repeat the step on dev |
| The Discord Activity does not load | use the web app (same code); the Activity is a bonus, not the only entry point |
| A command answers "This interaction failed" | the proxy did not answer in 3 s: show the `discord-proxy` logs, the interactions endpoint URL of the app |
| The managed certificate is not `ACTIVE` | `gcloud compute ssl-certificates list`; fall back to dev while it settles (up to an hour after a first deploy) |
| The pipeline is slow or waiting for a runner | show a finished run of the same job; the runners are ephemeral and a node can take a few minutes to join |
| Screen sharing drops | rejoin, share a single window, continue with the next table row |

## Rehearsal

1. **Before**: every track runbook has its `TODO(prd)` markers replaced; the team checklist above is green.
2. **Run it as the real thing**: one member shares the screen and follows the order of the demo, the others play the jury
   and ask the questions of the "Design choices to defend" tables. A person who built a part does not present it.
3. **Time it** against the slot: the total of the section timings must fit with room for questions. Cut by shortening
   a table row, never by skipping a point of subject 5.3.
4. **Write down every stumble**: a command that failed, an answer nobody knew, a tab that was not open. Each one becomes
   a fix of the runbook or of the system before the next run.
5. **Repeat** until a run goes through without a fix, then check once more the hardware of each member.

| Rehearsal | Date | Duration | Presenters (infra / functions / front) | Problems found | Fixed |
| --- | --- | --- | --- | --- | --- |
| 1 | _to fill_ | _to fill_ | _to fill_ | _to fill_ | _to fill_ |
| 2 | _to fill_ | _to fill_ | _to fill_ | _to fill_ | _to fill_ |
