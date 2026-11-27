// Requests as the API Gateway forwards them to the web API functions.

export const USER = { id: "123456789012345678", name: "alice" };

export function userinfo(claims = { sub: USER.id, username: USER.name, iss: "urn:x", aud: "urn:y" }) {
  return Buffer.from(JSON.stringify(claims)).toString("base64url");
}

export function apiRequest({ method = "POST", body, path = "/pixels", headers = {}, user = true } = {}) {
  const all = {
    ...(user ? { "x-apigateway-api-userinfo": userinfo() } : {}),
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };
  return { method, path, url: path, body, headers: all, get: (name) => all[name.toLowerCase()] };
}

export function apiResponse() {
  const res = { statusCode: 200, headers: {}, body: undefined, ended: false };
  res.status = (code) => ((res.statusCode = code), res);
  res.set = (name, value) => ((res.headers[name] = value), res);
  res.json = (body) => ((res.body = body), res);
  res.end = () => ((res.ended = true), res);
  return res;
}
