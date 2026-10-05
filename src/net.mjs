// The router's addresses as clients see them, and the /healthz probe that tells a jev-router from
// anything else on a port.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { hasControlCharacter } from './files.mjs';

/** @import { Health } from './types.js' */

/** The address the router and its live view listen on by default. */
export const LOOPBACK = '127.0.0.1';
/** The live view's default port. */
export const UI_PORT = 4100;
/** The header that carries the router token. */
export const TOKEN_HEADER = 'x-jev-router-token';

/**
 * @param {string | number} value
 * @returns {number} a TCP port; 0 asks the OS for any free one
 */
export function parsePort(value) {
  const port = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`port must be a number from 0 to 65535, got "${value}"`);
  return port;
}

/**
 * The address for `--ui` and JEV_ROUTER_UI: a port, or host:port ([::]:4100 for IPv6).
 * @param {string | undefined} value
 * @returns {{ host: string, port: number } | undefined} undefined when no view is wanted
 */
export function parseUiAddress(value) {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return { host: LOOPBACK, port: parsePort(value) };
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d+)$/.exec(value);
  // A control character in the host would end up in a service file, and no host has one.
  if (!match || hasControlCharacter(value)) throw new Error(`--ui takes a port or host:port, got ${JSON.stringify(value)}`);
  return { host: match[1] ?? match[2], port: parsePort(match[3]) };
}

/**
 * Whether a server could listen on host:port now: the port may be held by something that doesn't
 * speak HTTP, which a probe can't see.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<string | undefined>} why it can't (EADDRINUSE, EACCES, …), or undefined when it can
 */
export function portProblem(host, port) {
  return new Promise((done) => {
    const server = net.createServer();
    server.once('error', (err) => done('code' in err && typeof err.code === 'string' ? err.code : err.message));
    server.listen({ host, port, exclusive: true }, () => server.close(() => done(undefined)));
  });
}

/**
 * A host as it goes into a URL: an IPv6 address in brackets.
 * @param {string} host
 */
export const urlHost = (host) => (host.includes(':') ? `[${host}]` : host);
/**
 * The address a client on this machine uses for a router bound to `host`: one bound to every interface is reached on loopback.
 * @param {string} host
 */
export const clientHost = (host) => (host === '0.0.0.0' || host === '::' ? LOOPBACK : urlHost(host));
/** @param {string} host */
export const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);

/**
 * A fetch for loopback servers that never goes through a proxy. With NODE_USE_ENV_PROXY=1 the
 * global fetch sends every request to HTTP_PROXY unless NO_PROXY names the host, and a loopback
 * System One call carries the conversation's routing state. It reads the whole body, follows no
 * redirect, and rejects the way fetch does: with the signal's reason on abort, and with a
 * TypeError whose `cause` has the socket error otherwise.
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
export function directFetch(url, init) {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const signal = init.signal ?? undefined;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
    const req = client.request(target, { method: init.method ?? 'GET', headers, agent: false, signal }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: err })));
      res.on('end', () => {
        /** @type {[string, string][]} */
        const pairs = [];
        for (const [name, value] of Object.entries(res.headers))
          if (value !== undefined) pairs.push([name, Array.isArray(value) ? value.join(', ') : value]);
        const status = res.statusCode ?? 500;
        // Response refuses a body on these statuses.
        const body = [101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, statusText: res.statusMessage, headers: pairs }));
      });
    });
    req.on('error', (err) => reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: err })));
    req.end(typeof init.body === 'string' ? init.body : undefined);
  });
}

/**
 * @typedef {{ answered: boolean, health?: Health }} Probe
 */
/**
 * Asks whatever listens at `url` for jev-router's /healthz. It uses a plain agent because loopback
 * needs no proxy: with NODE_USE_ENV_PROXY=1 the default agent would send this to HTTP_PROXY.
 * @param {string} url
 * @returns {Promise<Probe>}
 */
export function probe(url) {
  return new Promise((done) => {
    const req = http.get(`${url}/healthz`, { agent: false, timeout: 1000 }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', () => done({ answered: true }));
      res.on('end', () => done({ answered: true, health: parseHealth(res.statusCode, Buffer.concat(chunks).toString()) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done({ answered: false }));
  });
}

/**
 * @param {number | undefined} status
 * @param {string} text
 * @returns {Health | undefined} the health report, if a jev-router sent it
 */
function parseHealth(status, text) {
  try {
    const body = JSON.parse(text);
    return status === 200 && body?.ok === true && typeof body.jev === 'object' ? body : undefined;
  } catch {
    return undefined;
  }
}
