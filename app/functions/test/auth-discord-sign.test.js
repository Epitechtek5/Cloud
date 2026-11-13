import { test } from "node:test";
import assert from "node:assert/strict";
import { createIamSigner, SigningError } from "../src/auth-discord/sign.js";
import { createFirebaseSigner } from "../src/auth-discord/firebase.js";

const SA = "fn-auth-discord@proj.iam.gserviceaccount.com";

/** Metadata server and IAM Credentials, answering as the real ones do. */
function fakeGoogle({ signStatus = 200, tokenBody = { access_token: "t", expires_in: 3599 } } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/email")) return new Response(` ${SA}\n`);
    if (String(url).endsWith("/token")) return new Response(JSON.stringify(tokenBody), { status: 200 });
    if (String(url).includes(":signJwt")) {
      const { payload } = JSON.parse(init.body);
      return new Response(JSON.stringify({ keyId: "k", signedJwt: `signed:${payload}` }), { status: signStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fetch.calls = calls;
  return fetch;
}

test("the signer uses the real clock when none is given, and trims the account email", async () => {
  const fetch = fakeGoogle();
  const signer = createIamSigner(fetch, 1000);
  assert.equal(await signer.email(), SA);
  assert.equal(await signer.sign({ sub: "42" }), 'signed:{"sub":"42"}');
  // The access token is cached: a second signature does not ask for another one.
  await signer.sign({ sub: "43" });
  assert.equal(fetch.calls.filter((c) => c.url.endsWith("/token")).length, 1);
});

test("a Firebase custom token with the real clock expires at most one hour later", async () => {
  const signer = createIamSigner(fakeGoogle(), 1000);
  const claims = JSON.parse((await createFirebaseSigner(signer)("42", 86_400)).slice("signed:".length));
  assert.equal(claims.iss, SA);
  assert.equal(claims.uid, "42");
  assert.equal(claims.exp - claims.iat, 3600);
});

test("the signer fails with a reason that names the step, never a secret", async () => {
  await assert.rejects(
    createIamSigner(fakeGoogle({ signStatus: 403 }), 1000).sign({}),
    (e) => e instanceof SigningError && e.reason === "sign_jwt_http_error" && e.status === 403,
  );
  await assert.rejects(
    createIamSigner(fakeGoogle({ tokenBody: {} }), 1000).sign({}),
    (e) => e instanceof SigningError && e.reason === "metadata_token_bad_response",
  );
});
