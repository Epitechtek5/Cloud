// One export per Cloud Run function (Terraform entry_point). Every function is
// deployed from the same zip and only runs its own entry point.
export { authDiscord } from "./auth-discord/handler.js";

export function hello(req, res) {
  res.status(200).send("ok");
}
