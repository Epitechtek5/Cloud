# Release

`release.yml` runs `semantic-release` on every push to `main`. A `feat:` commit creates a minor version, a `fix:`
(or `perf:`) a patch, and `!` or a `BREAKING CHANGE:` footer a major one. It creates the `vX.Y.Z` tag and the
GitHub Release. The tag then triggers `deploy.yml`. There is no `git` plugin, so nothing is committed back to `main`.

`pr-title.yml` checks PR titles against Conventional Commits, because a squash merge turns the title into the
commit message that semantic-release reads.

## Release GitHub App

A tag pushed with the default `GITHUB_TOKEN` does not trigger other workflows, so the release runs as a GitHub App.

1. Create the app (organization settings, Developer settings, GitHub Apps), no webhook.
2. Minimal repository permissions: **Contents: read and write** (push the tag, create the release),
   **Issues: read and write** and **Pull requests: read and write** (semantic-release comments on released
   issues and PRs), Metadata: read. Nothing else.
3. Install it on `Epitechtek5/Cloud` only.
4. Add the repository secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`.

The private key is the one long-lived credential of this setup, and it only grants the permissions above on this
repository, never cloud access. Cloud access stays keyless (OIDC).

## Tag ruleset

Create a ruleset on `refs/tags/v*` with the rules **Restrict updates**, **Restrict deletions** and
**Restrict creations**, with the release app as the only bypass actor. Updates and deletions are then impossible
for everyone, and only the app can create a tag.

## Dry run

Run the `release` workflow manually (Actions, `release`, Run workflow) on a test branch with `dry_run` enabled.
It prints the next version and the release notes without creating anything. Locally:
`npx semantic-release --dry-run --no-ci --branches <branch>`.

## Tag signing (decision to confirm with the team)

Proposal: **do not sign tags with a GPG key in CI.** Storing a signing key in GitHub is a second long-lived
secret, which goes against the keyless goal. The integrity guarantees come instead from the tag ruleset (only the
release app can create tags, nobody can move or delete them) and from the GitHub Release being produced by a
workflow run that can be audited. If the subject requires "Verified" tags, the alternative is a dedicated GPG key
stored as a secret, configured with `tag.gpgSign`; this issue should then be revisited.
