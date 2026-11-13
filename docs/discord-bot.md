# Discord bot: interactions proxy

The bot uses **Discord Interactions only** (HTTP slash commands, subject 3.2): no gateway connection, no
long-running process. Discord POSTs every interaction to the API Gateway, which forwards it to the
`discord-proxy` function (C06 Hands-on 3).

```
Discord --POST (signed)--> API Gateway --OIDC--> discord-proxy --discord.command--> Pub/Sub --> command worker
                                                     |                                              |
                                                     +-- 200 {type: 5} "thinking..." <--            +-- edits the response
                                                                                                         (interaction token)
```

## What the proxy does (`app/functions/src/discord`)

1. **Verifies the Ed25519 signature first**, over the raw body, with `X-Signature-Ed25519` and
   `X-Signature-Timestamp` and the application public key. Missing, malformed or wrong signature: `401`.
   A timestamp more than 5 minutes away is refused too (replay).
2. `PING` (type 1): `PONG` (type 1). This is how Discord validates the endpoint URL.
3. Slash command (type 2): publishes a `discord.command` event (command, subcommand, flattened options,
   interaction id/token and application id to edit the answer later, guild, channel, user, member roles and
   permissions, `correlation_id`), then answers a **deferred response** (type 5, "thinking..."). `/admin` is
   deferred as ephemeral. The event is published *before* answering: once the response is sent the instance
   may lose its CPU.
4. Anything else: `400`. No business logic, no grid write.

If publishing fails the proxy answers `500` and Discord shows "This interaction failed": nothing is silently
lost. ("The application did not respond" is what users see when the 3 s deadline is missed.)

## Infrastructure (`module "discord_proxy"` in `infra/serverless/functions.tf`)

One `modules/function` instance, entry point `discordProxy`, deployed only when `discord_proxy_enabled = true`
in `<env>.tfvars` (off by default, see the bootstrap below):

- Dedicated service account `fn-discord-proxy`: `secretmanager.secretAccessor` on `discord-public-key` only
  (injected as `DISCORD_PUBLIC_KEY`), `logging.logWriter` and `cloudtrace.agent`. Publishing on
  `discord.command` only, granted on that topic in `infra/serverless/pubsub.tf`
  (`publishers["discord.command"]`): it cannot publish anywhere else.
- `roles/run.invoker` only for `local.gateway_invokers`, the API Gateway service account (#60), never `allUsers`:
  the function URL answers `403` to anyone else.
- Timeout 10 s, scale to zero, at most 5 instances.

The gateway route is `POST /discord/interactions`, backend `module.discord_proxy.uri` (output `discord_proxy_uri`), **without** JWT
authentication at the gateway (Discord does not send one): the signature check is the authentication.

## One Discord application per environment

As for the Activity ([discord-activity.md](discord-activity.md)), dev and prd each have their own application.
For each environment:

1. Copy the **Public Key** of the application (General Information) into the secret:

   ```bash
   printf '%s' '<public key hex>' | gcloud secrets versions add discord-public-key --data-file=- --project <project_id>
   ```

   The value never goes through Terraform state or GitHub. The first apply of an environment creates the
   secret empty, and Cloud Run cannot start a revision on a secret without a version: this is why the proxy
   is off by default.
2. Set `discord_proxy_enabled = true` in `infra/serverless/<env>.tfvars` (PR), then deploy.
3. Set **Interactions Endpoint URL** to the output `discord_interactions_url`
   (`terraform -chdir=infra/serverless output -raw discord_interactions_url`). Discord sends a signed
   PING and also checks that a badly signed request gets `401`: saving the URL only succeeds if both work.
4. Register the slash commands (next section).

## Slash commands

Definitions versioned in [`app/functions/commands/commands.json`](../app/functions/commands/commands.json)
(subject 3.2, C07 §1.1):

| Command | Options | First barrier (`default_member_permissions`) |
| --- | --- | --- |
| `/draw` | `x`, `y` (integers `0..99999`), `color` (`#RRGGBB`, `RRGGBB` or a palette name) | everyone |
| `/get` | none | everyone |
| `/snapshot` | none | Administrator |
| `/admin pause` / `resume` / `clear` | none | Administrator |
| `/admin ratelimit` | `user` (Discord user), `limit` (pixels per minute, `0..1000`) | Administrator |

`default_member_permissions` only hides the command from non-admins in the Discord UI: guild admins can
change it, so **the real authorization stays in the worker**. Colours are parsed with `parseColor`
(`src/lib/colors.js`, same palette as the web canvas). The commands are guild-only (`contexts: [0]`).

### Registration

`app/functions/commands/register.js` compares the definitions with the registered ones and only overwrites
them (bulk `PUT`) when they differ: re-running it is idempotent and reports `already up to date`. Guild
commands by default, so they show up at once in the dev and prd guilds.

**Pipeline**: `deploy-env.yml` runs it after the Terraform apply of each environment (dev on every push to
`dev`, prd on release). The bot token is read from Secret Manager (`discord-bot-token`, readable only by the
deploy service account through `google_secret_manager_secret_iam_member.deploy_reads_bot_token` in
`infra/serverless/secrets.tf`) with the environment's OIDC identity: it is never a GitHub secret, and it is masked in the logs. The step is skipped until these
**GitHub Environment variables** are set on `dev` and `prd`:

| Variable | Value |
| --- | --- |
| `DISCORD_APPLICATION_ID` | application id of the environment's Discord app |
| `DISCORD_GUILD_ID` | guild where the commands are registered (leave empty for global commands) |

Then add the token once per environment (Bot, Reset Token in the developer portal):

```bash
printf '%s' '<bot token>' | gcloud secrets versions add discord-bot-token --data-file=- --project <project_id>
```

**By hand** (same script, e.g. to test a change on dev):

```bash
cd app/functions
DISCORD_BOT_TOKEN="$(gcloud secrets versions access latest --secret=discord-bot-token --project <project_id>)" \
  node commands/register.js --application-id <app id> --guild-id <guild id> [--dry-run]
```

## Tests

- Unit (`npm test` in `app/functions`): signature over the raw body (valid, tampered body/timestamp, foreign
  key, malformed headers, replay), PING, deferred ack, published event, publish and secret failures.
- Commands (`test/commands`): the mandatory commands and options, grid bounds, admin barrier, idempotent
  registration against a fake Discord API (second run makes no `PUT`), token never printed, 429 retry.
- Live, through the gateway: `scripts/test-discord-proxy.sh https://<gateway host>/discord/interactions`
  (unsigned and badly signed requests get `401`). The positive live test is the PING validation of step 2,
  then `/draw` in Discord showing "thinking..." and a message on `discord.command`
  (`jsonPayload.correlation_id` in Cloud Logging, or the `discord.command.sub` subscription while no worker
  consumes it).
