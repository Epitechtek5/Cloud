/**
 * `fetch` resolved at call time. In an Activity, `patchUrlMappings` REPLACES `window.fetch`
 * to route requests through the Discord proxy: a reference captured earlier (or a bound copy)
 * would keep using the original and bypass the proxy, which the iframe CSP then blocks.
 */
export const lateFetch: typeof fetch = (...args) => globalThis.fetch(...args);
