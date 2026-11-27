# Security summary of the infra track

Subject 5.3 (least privilege, secrets, OIDC, what is public) and 5.6, issue #80. The serverless identities (one
service account per function) are in [`functions.md`](functions.md); this page covers the people, the pipeline, the
runners and the secrets. Every role below is created by Terraform with its reason next to it
([`infra/access/roles.tf`](../infra/access/roles.tf), [`infra/access/humans.tf`](../infra/access/humans.tf)).

## Identities

| Identity | Who uses it | How it authenticates | What it may do |
| --- | --- | --- | --- |
| Team members | the three of us | Google account | `roles/owner` on each project: the only role that can apply `infra/access` and `infra/billing` on a project without organization |
| Instructor | the instructor | Google account | `roles/editor` on both projects (subject C01 §4.3), `roles/billing.viewer` on the billing account |
| GitHub collaborators | team and instructor | GitHub account | repository permission set in `infra/access` (prd state, `github_repository_collaborator`) |
| `gha-deploy@<project>` | `deploy-env`, `destroy`, `architecture` (extract) | WIF: the exact `sub` of a job of **this repository in this GitHub Environment**, 1 h token | one role per resource family of `foundation` and `serverless` instead of `roles/editor` (none can create a key, mint a token or set the project IAM policy); `projectIamAdmin` **conditioned** to an allow-list of grantable roles (never `owner`, `editor` or an admin role); custom roles `ghaDeployIamBindings` (IAM of the resources it creates) and `ghaDeployK8sRbac` (RBAC objects of the ARC charts); `objectAdmin` on the state bucket |
| `gha-plan@<project>` | `ci-terraform` plans on PRs | WIF: any job of this repository (the sub varies per PR) | `roles/viewer`, `iam.securityReviewer`, `firebaserules.viewer`: read only. On the state bucket, `objectViewer` plus `objectUser` **only on `*.tflock`**: it can never write a state |
| Runner nodes SA | the GKE nodes | attached to the node pool | `roles/container.defaultNodeServiceAccount` only (logs, metrics, image pulls). Pods cannot use it: the nodes run `GKE_METADATA` |
| Release GitHub App | `release`, `architecture` (publish) | app id + private key (repository secrets) | pushes the `v*` tag and the release, opens the diagram PR to `dev` |
| ARC GitHub App | the ARC listener in the cluster | app id, installation id, private key (Kubernetes secret) | registers ephemeral runners on this repository (Actions read, Administration read/write, Metadata read) |

Isolation between environments is checked by `wif-isolation.yml`: a job of the `dev` Environment gets the dev deploy
account and is refused both prd accounts. A deleted and re-created repository with the same name is refused too: the
provider condition pins the repository and owner **ids**.

## Secrets inventory

No service account key exists: every cloud credential of the pipeline is a short-lived WIF token.

| Secret | Stored in | Read by | Created by |
| --- | --- | --- | --- |
| `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY` | GitHub repository secrets | `release`, `architecture` (publish job, no cloud credential) | a repository admin |
| `ANTHROPIC_API_KEY` | GitHub secret of the `prd` Environment | `architecture` (generate job, no cloud credential) | a repository admin |
| `discord-public-key`, `discord-oauth-client-secret`, `discord-bot-token` | Secret Manager of each project. Since #134 the **containers** belong to `infra/access` (`persistent.tf`) and survive a destroy | `discord-proxy`, `auth-discord` (as Secret Manager references in their environment), `gha-deploy` for the bot token (registers the slash commands) | values added by hand (`gcloud secrets versions add`), never in tfvars, Git or a state |
| `arc-github-app` | Kubernetes secret in `arc-runners` | the ARC controller and listener | by hand once per cluster ([runners doc](ci/self-hosted-runners.md), Install §4); a destroy deletes it with the namespace |

Not secrets, but kept out of Git: `infra/access/<env>.local.tfvars` (team emails, billing account, git-ignored).
The GitHub variables (`GCP_WORKLOAD_IDENTITY_PROVIDER*`, `GCP_*SERVICE_ACCOUNT*`, `TF_STATE_BUCKET*`, `CI_RUNNER*`) are
identifiers, published by `scripts/publish-github-variables.sh`.

Leaks are caught by gitleaks on every PR and on `main` ([`ci/security.md`](ci/security.md)); a leaked secret is
rotated first, removing it from the code is not enough.

## What is public, and why

| Exposed | Protection | Why it is public |
| --- | --- | --- |
| Frontend load balancer (`<ip>.sslip.io`) | HTTPS only (HTTP answers 301), managed certificate, SSL policy MODERN / TLS 1.2+, private bucket behind it | it serves the web app |
| API Gateway (`*.gateway.dev`) | session JWT checked at the gateway, Ed25519 signature for Discord, functions invokable by the gateway account only | the only entry point of the app (subject 3.1) |
| GKE control plane, DNS-based endpoint | every request authenticated and authorized by IAM; the IP-based endpoint is closed (empty authorized networks) | the deploy jobs run on GitHub-hosted runners, whose IPs are unknown |

Everything else is private: the nodes have no public IP and no ingress (firewall and NetworkPolicy), the buckets
enforce public access prevention (the state bucket too), every function needs `roles/run.invoker`, and Firestore
only serves the browser through its security rules (read only).

## Known trade-offs

| Trade-off | Why it is accepted | Mitigation |
| --- | --- | --- |
| Runner pods use `dind` (privileged Docker sidecar) | jobs build containers and run job containers | one ephemeral pod per job, dedicated namespace, egress to the Internet only, ingress denied, nodes without the node identity for pods |
| The ARC GitHub App key is a hand-made Kubernetes secret | the External Secrets / CSI integration is #54 | documented manual step, deleted with the cluster |
| Actions are referenced by major tag, not by commit SHA | only official GitHub, Google and HashiCorp actions plus `dorny/paths-filter` ([open-source list](open-source-infra.md)) | review of every workflow change; pinning by SHA is the next step |
| Semgrep does not block yet | first findings not triaged | gitleaks, checkov, tflint and `npm audit` block |
| The frontend IP is kept (and billed, a few USD/month) after a destroy (#134) | the URL, the certificate and the Discord redirect URIs derive from it | the only billable leftover, in the access stack |
