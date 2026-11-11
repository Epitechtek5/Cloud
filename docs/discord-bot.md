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

If publishing fails the proxy answers `500` and Discord shows "The application did not respond": nothing is
silently lost.

## Infrastructure (`infra/serverless/modules/discord_proxy`)

- Dedicated service account: `secretmanager.secretAccessor` on the public key secret only, `logging.logWriter`
  and `cloudtrace.agent`. Publishing on `discord.command` is granted by the Pub/Sub module: pass
  `module.discord_proxy.service_account_email` in `publishers["discord.command"]`.
- `roles/run.invoker` only for `invoker_members` (the API Gateway service account). `allUsers` is refused by
  a validation: the function is not invokable outside the gateway.
- Timeout 10 s, scale to zero, `max_instances` 5 by default.

Wiring in the `infra/serverless` stack (once the stack and the gateway exist, #57 and #60):

```hcl
module "discord_proxy" {
  source          = "./modules/discord_proxy"
  project_id      = var.project_id
  region          = var.region
  source_bucket   = google_storage_bucket.sources.name
  source_object   = google_storage_bucket_object.functions.name
  invoker_members = ["serviceAccount:${google_service_account.gateway.email}"]
}

module "pubsub" {
  # ...
  publishers = { "discord.command" = [module.discord_proxy.service_account_email] }
}
```

The gateway route is `POST /discord/interactions`, backend `module.discord_proxy.url`, **without** JWT
authentication at the gateway (Discord does not send one): the signature check is the authentication.

## One Discord application per environment

As for the Activity ([discord-activity.md](discord-activity.md)), dev and prd each have their own application.
For each environment:

1. Copy the **Public Key** of the application (General Information) into the secret:

   ```bash
   printf '%s' '<public key hex>' | gcloud secrets versions add discord-public-key --data-file=- --project <project_id>
   ```

   The value never goes through Terraform state or GitHub.
2. Set **Interactions Endpoint URL** to `https://<gateway host>/discord/interactions`. Discord sends a signed
   PING and also checks that a badly signed request gets `401`: saving the URL only succeeds if both work.
3. Register the slash commands (next issue: `/draw`, `/get`, `/snapshot`, `/admin`).

## Tests

- Unit (`npm test` in `app/functions`): signature over the raw body (valid, tampered body/timestamp, foreign
  key, malformed headers, replay), PING, deferred ack, published event, publish and secret failures.
- Live, through the gateway: `scripts/test-discord-proxy.sh https://<gateway host>/discord/interactions`
  (unsigned and badly signed requests get `401`). The positive live test is the PING validation of step 2,
  then `/draw` in Discord showing "thinking..." and a message on `discord.command`
  (`jsonPayload.correlation_id` in Cloud Logging, or the `discord.command.sub` subscription while no worker
  consumes it).
