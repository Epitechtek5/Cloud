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

## Tag signing (decision: tags are not signed)

Decision: **tags are not signed with a GPG key in CI.** The parent issue accepts either a GPG key or a written
justification, and this is the justification.

- A signing key stored in GitHub is a second long-lived secret, which goes against the keyless goal.
- `semantic-release` creates lightweight tags, which cannot be "Verified". Signing would require annotated tags
  (`tag.gpgSign`), a key imported at every run, and rotation.
- A GitHub App has no GPG key setting, and the "Verified" badge needs a key attached to a user account. It would
  need a dedicated machine user that becomes the author of the tags instead of the app.
- Keyless signing (Sigstore `gitsign`) fits the goal, but GitHub does not show "Verified" for it.

Integrity comes from the tag ruleset (only the release app can create `v*` tags, nobody can move or delete them)
and from every release being produced by a workflow run that can be audited.

Revisit this if the subject or a reviewer explicitly requires "Verified" tags: use a dedicated machine user, a
GPG key stored as a secret, and `tag.gpgSign`, and update the ruleset bypass actor accordingly.
