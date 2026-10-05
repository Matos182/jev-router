// jev-router: a pass-through proxy that picks a model tier for each coding-agent session with Jev,
// TypeSafe's System One decision model.
//
// Claude Code speaks Anthropic Messages to it and Codex CLI speaks OpenAI Responses. Requests go
// upstream unchanged except for `model`, the credential, and the fields a target can't accept;
// responses stream back byte for byte. Jev is asked on new human turns only, and in an ongoing
// session the tier only goes up, because switching models mid-task costs the prompt cache.

import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { applyPolicy, buildState, JevClient, policyFor } from './jev.mjs';
import { header, humanTurns, items, tierTag } from './messages.mjs';
import { findSecrets, mayContainSecret, redactBody } from './secrets.mjs';
import { SessionStore } from './sessions.mjs';
import { costOf, UsageTap } from './usage.mjs';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/**
 * @import { Config, ConfigSummary, ContentBlock, Decision, Env, Health, IncomingHttpHeaders, Item, JevAnswer, JevFailure, JevInfo, JevOption, JevSuccess,
 *   LogEntry, ModelTotals, Report, RequestBody, RouterOptions, RouterServer, SessionEntry, SessionKey, Surface, SurfaceTargets,
 *   Target, Turn, Usage } from './types.js'
 */

/**
 * What the decision rules know about a request, gathered once before any rule runs.
 * @typedef {object} Facts
 * @property {Config} cfg the config when the request arrived
 * @property {IncomingHttpHeaders} headers
 * @property {RequestBody} body
 * @property {number} bodyBytes
 * @property {SessionKey} key
 * @property {SessionEntry | undefined} entry the session's stored state
 * @property {string | undefined} kind see requestKind
 * @property {Turn[]} turns
 * @property {Turn | undefined} latest the latest human turn
 * @property {number} secrets secrets found in the latest human turn
 * @property {boolean} trustedOnly
 * @property {boolean} fresh no ongoing decision to build on: a new, provisional, compacted or idle session
 * @property {Pick<Decision, 'key' | 'kind' | 'turnCount' | 'latestIndex' | 'latestText'>} base
 */

/**
 * A request that passed the router's checks, with its body parsed.
 * @typedef {object} Accepted
 * @property {string} path
 * @property {Surface} surface
 * @property {SurfaceTargets} targets the surface's targets when the request arrived
 * @property {string} text the body as received
 * @property {number} bodyBytes
 * @property {RequestBody} body
 */

/** The router's version, as /healthz and `jev-router version` report it. */
export const VERSION = '1.6.0';
/** @type {Partial<Record<string, Surface>>} */
const SURFACES = { '/v1/messages': 'anthropic', '/v1/messages/count_tokens': 'anthropic', '/v1/responses': 'openai' };
const HOP = [
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'content-length',
];
const DROP_REQUEST = new Set([...HOP, 'accept-encoding', 'authorization', 'x-api-key', 'x-jev-tier', 'x-jev-router-token']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding']);
// What an upstream that isn't trusted with secrets (for example Ollama Cloud) receives. Claude Code's
// session and agent ids and the account identifiers in `metadata` stay with the first-party provider.
const MINIMAL_HEADERS = new Set(['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent']);
/** @type {ReadonlySet<string | undefined>} */
const CHEAP_KINDS = new Set(['auxiliary', 'memory_consolidation']);
/** @type {ReadonlySet<string | undefined>} */
const SIGNED = new Set(['thinking', 'redacted_thinking', 'reasoning']);
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
/** @type {Partial<Record<number, string>>} */
const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  415: 'invalid_request_error',
};
/** How many different warnings the router remembers, to log each one once. */
const MAX_WARNINGS = 100;
/** @param {string} text */
const sha = (text) => createHash('sha256').update(text).digest('hex');
/**
 * The session id that logs and response headers show: a hash, so the session key never leaves the router.
 * @param {string} key
 */
const sessionId = (key) => sha(key).slice(0, 12);

/**
 * The conversation a request belongs to, from the ids the clients send or, without one, a hash of
 * how the conversation starts.
 * @param {IncomingHttpHeaders} headers
 * @param {RequestBody} body
 * @returns {SessionKey}
 */
export function sessionKey(headers, body) {
  /** @type {unknown} */
  let fromMetadata; // Claude Code 2.1.x: metadata.user_id is JSON with session_id; older: "…_session_<id>"
  try {
    fromMetadata = JSON.parse(body.metadata?.user_id ?? '').session_id;
  } catch {
    fromMetadata = body.metadata?.user_id?.match?.(/_session_([\w-]+)/)?.[1];
  }
  /** @type {Array<[source: string, id: unknown]>} */
  const sources = [
    ['claude-code-header', headers['x-claude-code-session-id']],
    ['claude-code-metadata', fromMetadata],
    ['codex-session', headers['session-id']],
    ['codex-thread', headers['thread-id']],
    ['prompt-cache-key', body.prompt_cache_key],
  ];
  for (const [source, id] of sources) if (typeof id === 'string' && id) return { id, source };
  // No client id: the system prompt and the first messages stay the same for a whole conversation.
  return { id: `h:${sha(JSON.stringify([body.system ?? body.instructions ?? null, items(body).slice(0, 2)]))}`, source: 'hash' };
}

/**
 * main | subagent | compaction | auxiliary | workflow, from Claude Code's hint headers and Codex's labels.
 * @param {IncomingHttpHeaders} headers
 * @returns {string | undefined} undefined when the client sent no hint
 */
export function requestKind(headers) {
  const cc = header(headers, 'x-claude-code-request-class');
  if (cc) return cc;
  const codex = header(headers, 'x-openai-subagent');
  if (codex) return codex === 'compact' ? 'compaction' : codex === 'memory_consolidation' ? 'auxiliary' : 'subagent';
  if (headers['x-claude-code-agent-id']) return 'subagent';
  return undefined;
}

/**
 * Creates the router, an HTTP server to `listen` on. It routes Anthropic Messages and OpenAI
 * Responses requests to the tier each one needs.
 * @param {Config} input a validated config
 * @param {RouterOptions} [options]
 * @returns {RouterServer}
 */
export function createRouter(
  input,
  { env = process.env, log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`), fetchImpl, store } = {},
) {
  let cfg = input;
  let jev = new JevClient(cfg.jev, env, { fetchImpl });
  // Defined before the session store: it loads the state file, and reports errors, while it is constructed.
  /** @type {Set<string>} each warning is logged once while it is remembered */
  const warned = new Set();
  /** @param {string} message */
  const warn = (message) => {
    if (warned.has(message)) return;
    // Some warnings quote what a client sent, so the set forgets its oldest rather than grow.
    if (warned.size >= MAX_WARNINGS) warned.delete(/** @type {string} */ (warned.values().next().value));
    warned.add(message);
    log({ ts: new Date().toISOString(), event: 'warning', message });
  };
  const sessions =
    store ??
    new SessionStore({
      file: cfg.stateFile,
      max: cfg.maxSessions,
      onError: (err) => warn(`session file: ${/** @type {Error} */ (err).message}`),
    });
  /** @type {Map<string, { answer: Promise<JevAnswer>, controller: AbortController, waiters: number }>} */
  const inflight = new Map();
  const started = Date.now();
  let active = 0;
  // Numbers each request, so its `route` and `done` log entries can be paired.
  let requests = 0;
  const token = env.JEV_ROUTER_TOKEN ?? cfg.token;
  const allowedHosts = () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : cfg.port;
    return new Set([...['127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${port}`), ...cfg.allowedHosts]);
  };

  /**
   * What the rules need to know about a request.
   * @param {{ headers: IncomingHttpHeaders, body: RequestBody, bodyBytes: number }} request
   * @returns {Facts}
   */
  function facts({ headers, body, bodyBytes }) {
    const key = sessionKey(headers, body);
    const stored = sessions.get(key.id);
    // A tier the config no longer has, after a switch to another config, counts as its top tier:
    // a session in the middle of a task never lands on a cheaper model than it had. Its model
    // changed, so its prompt cache is cold anyway, and the next human turn is decided afresh.
    const entry =
      stored && !cfg.tiers.includes(stored.tier) ? { ...stored, tier: cfg.tiers[cfg.tiers.length - 1], freshNext: true } : stored;
    const kind = requestKind(headers);
    const turns = humanTurns(body);
    const latest = turns.at(-1);
    // Deterministic secret scan of what the human just wrote. A hit keeps the whole session on
    // trusted upstreams, whatever tags, pins or Jev say.
    const secrets = latest ? findSecrets(latest.text).length : 0;
    const idleMs = cfg.policy.idleResetMinutes * 60000;
    return {
      cfg,
      headers,
      body,
      bodyBytes,
      key,
      entry,
      kind,
      turns,
      latest,
      secrets,
      trustedOnly: Boolean(entry?.trustedOnly || secrets),
      fresh: !entry || entry.provisional || entry.freshNext || Date.now() - (entry.lastSeen ?? entry.updated ?? 0) > idleMs,
      base: { key, kind, turnCount: turns.length, latestIndex: latest?.index, latestText: latest?.text },
    };
  }

  /**
   * Decides the tier for one request, and what to remember about its session.
   * @param {{ headers: IncomingHttpHeaders, body: RequestBody, bodyBytes: number, countOnly: boolean, signal: AbortSignal }} request
   * @returns {Promise<Decision>}
   */
  async function decide(request) {
    const f = facts(request);
    if (request.countOnly) return follow(f, 'count-tokens');
    return settleByRequest(f, env, warn) ?? settleByTurn(f, jev.configured, warn) ?? (await consultJev(f, request.signal));
  }

  /**
   * One Jev call per human turn, shared by concurrent requests of that turn. It is cancelled only
   * when every request waiting for it has gone away, so one client that leaves can't take the
   * decision from the others.
   * @param {Facts} f
   * @param {AbortSignal} signal
   * @returns {Promise<Decision>}
   */
  async function consultJev(f, signal) {
    if (signal.aborted) return follow(f, 'client-aborted');
    const flightKey = `${f.key.id}#${f.turns.length}`;
    let flight = inflight.get(flightKey);
    if (!flight) {
      log({ ts: new Date().toISOString(), event: 'deciding', session: sessionId(f.key.id), turn: f.turns.length });
      const state = buildState({ body: f.body, headers: f.headers, turns: f.turns, bodyBytes: f.bodyBytes, jev: cfg.jev });
      const controller = new AbortController();
      const answer = jev.decide(state, { signal: controller.signal }).finally(() => inflight.delete(flightKey));
      flight = { answer, controller, waiters: 0 };
      inflight.set(flightKey, flight);
    }
    const shared = flight;
    shared.waiters += 1;
    const leave = () => {
      shared.waiters -= 1;
      if (shared.waiters === 0) shared.controller.abort();
    };
    signal.addEventListener('abort', leave, { once: true });
    let answer;
    try {
      answer = await shared.answer;
    } finally {
      signal.removeEventListener('abort', leave);
    }
    return answer.ok ? afterJevAnswer(f, answer, cfg.jev.options) : afterJevFailure(f, answer);
  }

  /**
   * Checks the route, content type, token and size of a request, and parses its body. When the
   * request can't be routed, answers it and returns undefined.
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {Promise<Accepted | undefined>}
   */
  async function accept(req, res) {
    const path = (req.url ?? '').split('?')[0];
    const surface = SURFACES[path];
    if (req.method !== 'POST' || !surface) return fail(res, 404, `No route for ${req.method} ${path}`);
    const targets = cfg.surfaces[surface];
    if (!targets) return fail(res, 404, `No route for ${path}: the config has no ${surface} surface`, surface);
    if (!(req.headers['content-type'] ?? '').includes('application/json'))
      return fail(res, 415, 'Content-Type must be application/json', surface);
    if (token && !safeEqual(req.headers['x-jev-router-token'] ?? '', token))
      return fail(res, 401, 'Missing or wrong x-jev-router-token header', surface);
    const raw = await readBody(req, cfg.maxBodyBytes);
    if (raw === null) return fail(res, 413, `Request body exceeds ${cfg.maxBodyBytes} bytes`, surface);
    const text = raw.toString();
    /** @type {unknown} */
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(res, 400, 'Request body is not JSON', surface);
    }
    if (!isJsonObject(body)) return fail(res, 400, 'Request body must be a JSON object', surface);
    return { path, surface, targets, text, bodyBytes: raw.length, body };
  }

  /**
   * Routes one request: checks it, decides its tier, records the session, logs the route, and
   * relays it to the target.
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {AbortSignal} signal aborts when the client goes away
   */
  async function handle(req, res, signal) {
    const startedAt = performance.now();
    const request = await accept(req, res);
    if (!request) return;
    requests += 1;
    const id = requests;
    const { path, surface, targets, body } = request;
    const countOnly = path.endsWith('/count_tokens');
    const decision = await decide({ headers: req.headers, body, bodyBytes: request.bodyBytes, countOnly, signal });
    const chosen = targets[decision.tier] ?? targets[cfg.tiers[0]];
    const target = decision.trustedOnly && !chosen.trusted ? targets.trusted : chosen;
    const host = new URL(target.url).host;
    const session = sessionId(decision.key.id);
    const main = decision.kind === undefined || decision.kind === 'main';
    const entry = storeDecision(sessions, decision, { host, main, countOnly });

    /** @type {Record<string, string>} */
    const shown = { 'x-jev-tier': decision.tier, 'x-jev-model': target.model, 'x-jev-reason': decision.reason, 'x-jev-session': session };
    log({
      ts: new Date().toISOString(),
      event: 'route',
      req: id,
      session,
      path,
      kind: decision.kind,
      key_source: decision.key.source,
      tier: decision.tier,
      reason: decision.reason,
      model: target.model,
      upstream: host,
      trusted_only: decision.trustedOnly || undefined,
      secrets: decision.secrets,
      jev: decision.jev,
    });
    // Never count a prompt with another provider's tokenizer; Claude Code estimates on a 404.
    if (countOnly && target.countTokens === false) return fail(res, 404, `${target.model} has no count_tokens endpoint`, surface, shown);
    if (signal.aborted)
      return log({
        ts: new Date().toISOString(),
        event: 'done',
        req: id,
        session,
        status: 499,
        client_aborted: true,
        ms: elapsed(startedAt),
      });

    const outgoing = prepareBody(body, request.text, target, !countOnly && main ? entry?.anchor : undefined);
    if (outgoing.redacted) shown['x-jev-redacted'] = String(outgoing.redacted);
    if (outgoing.capped) shown['x-jev-max-tokens'] = String(outgoing.capped);
    const status = await relay(req, res, { id, target, surface, session, shown, signal, startedAt, ...outgoing });
    if (main && status !== undefined && status < 300 && decision.tier !== 'side' && !countOnly && entry && entry.lastHost !== host)
      sessions.set(decision.key.id, { ...entry, lastHost: host });
  }

  /**
   * Sends a request to its target and streams the response back, then logs its usage and cost. A
   * failure before the response is a 502 in the client's shape; a stream that breaks off is cut
   * short for the client too, and still logs what it cost.
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {{ id: number, target: Target, surface: Surface, session: string, shown: Record<string, string>, signal: AbortSignal,
   *   startedAt: number, body: RequestBody, redacted: number, capped?: number, folded?: number }} route
   * @returns {Promise<number | undefined>} the upstream's status, or undefined when the request failed
   */
  async function relay(req, res, { id, target, surface, session, shown, signal, startedAt, body, redacted, capped, folded }) {
    const ts = () => new Date().toISOString();
    const host = new URL(target.url).host;
    let result;
    try {
      result = await forward(req, res, target, body, shown, signal, env);
    } catch (err) {
      if (signal.aborted) {
        log({ ts: ts(), event: 'done', req: id, session, status: 499, client_aborted: true, ms: elapsed(startedAt) });
        return undefined;
      }
      const why = `request to ${host} failed: ${failure(err)}`;
      log({ ts: ts(), event: 'error', req: id, session, error: `upstream ${why}` });
      if (!res.headersSent) fail(res, 502, `Upstream ${why}`, surface, shown);
      else res.destroy();
      return undefined;
    }
    if (result.broken) log({ ts: ts(), event: 'error', req: id, session, error: result.error ?? 'the upstream stream broke off' });
    const baselineModel = cfg.baselineModel?.[surface];
    log({
      ts: ts(),
      event: 'done',
      req: id,
      session,
      status: result.status,
      model: target.model,
      ms: elapsed(startedAt),
      bytes: result.bytes,
      sha256: result.sha256,
      redacted: redacted || undefined,
      capped_max_tokens: capped,
      folded_system: folded,
      error: result.error,
      client_aborted: result.aborted || undefined,
      usage: result.usage,
      cost_usd: costOf(target.model, result.usage, cfg.prices),
      baseline_usd: baselineModel ? costOf(baselineModel, result.usage, cfg.prices) : undefined,
    });
    return result.broken ? undefined : result.status;
  }

  const server = http.createServer((req, res) => {
    // Requests from a browser tab (cross-site or DNS rebinding) must not spend your keys.
    const host = req.headers.host;
    if (host === undefined || !allowedHosts().has(host)) return fail(res, 403, `Host "${host}" is not allowed`);
    if (req.headers.origin && !(cfg.allowedOrigins ?? []).includes(req.headers.origin))
      return fail(res, 403, 'Cross-origin requests are not allowed');
    if (req.method === 'GET' && req.url === '/healthz') return health(res);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    active += 1;
    handle(req, res, controller.signal)
      .catch((/** @type {Error} */ err) => {
        // one malformed request must not take the router down
        const error = controller.signal.aborted ? `the client went away before the request was routed: ${err.message}` : err.message;
        log({ ts: new Date().toISOString(), event: 'error', path: req.url, error });
        if (!res.headersSent) fail(res, 500, 'The router could not handle this request', SURFACES[(req.url ?? '').split('?')[0]]);
        else res.destroy();
      })
      .finally(() => {
        active -= 1;
      });
  });

  /** @param {ServerResponse} res */
  function health(res) {
    /** @type {Health} */
    const body = {
      ok: true,
      version: VERSION,
      uptime_s: Math.round((Date.now() - started) / 1000),
      sessions: sessions.size,
      active,
      jev: { configured: jev.configured, channels: jev.health() },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  server.on('listening', () => void jev.warm());
  server.on('close', () => jev.close());

  // Not Object.assign: it would read the `active` getter once and copy a 0 that never changes.
  Object.defineProperties(
    server,
    Object.getOwnPropertyDescriptors({
      sessions,
      get active() {
        return active;
      },
      /** @param {Config} next */
      reload(next) {
        // Start the new loads before aborting the old ones, so a reload during a cold load keeps a load in flight.
        const previous = jev;
        cfg = next;
        jev = new JevClient(cfg.jev, env, { fetchImpl });
        void jev.warm();
        previous.close();
      },
    }),
  );
  // defineProperties added exactly the RouterServer extras.
  return /** @type {RouterServer} */ (server);
}

// ---------------------------------------------------------------------------------------------
// Decision rules. Each returns a decision when it settles the request, or undefined to go on.

/**
 * The session keeps its tier (the default tier for a new session).
 * @param {Facts} f
 * @param {string} reason
 * @returns {Decision}
 */
function follow(f, reason) {
  return { ...f.base, tier: f.entry?.tier ?? f.cfg.defaultTier, reason, trustedOnly: f.trustedOnly };
}

/**
 * The request gets `tier`, and the session is stored with it.
 * @param {Facts} f
 * @param {string} tier
 * @param {string} reason
 * @param {Partial<SessionEntry>} [extra] more to store, or to change, in the session entry
 * @returns {Decision}
 */
function remember(f, tier, reason, extra = {}) {
  const { trustedOnly } = f;
  return {
    ...f.base,
    tier,
    reason,
    trustedOnly,
    remember: { tier, trustedOnly, provisional: false, attempts: 0, freshNext: false, ...extra },
  };
}

/**
 * Rules that settle a request by what it is: a background call, a subagent or other non-main
 * request, a tier pin, or a /model switch.
 * @param {Facts} f
 * @param {Env} env
 * @param {(message: string) => void} warn
 * @returns {Decision | undefined}
 */
function settleByRequest(f, env, warn) {
  const { cfg, headers, body, entry, kind, turns } = f;
  // Background calls: Claude Code's small-model requests (titles, topic checks) and quota probes.
  // With hint headers the request class decides; the model-name rule applies only without them.
  if (
    CHEAP_KINDS.has(kind) ||
    (body.max_tokens !== undefined && body.max_tokens <= 1) ||
    (kind === undefined && new RegExp(cfg.sideCallModel, 'i').test(body.model ?? ''))
  ) {
    return { ...f.base, tier: 'side', reason: 'side-call', trustedOnly: f.trustedOnly };
  }
  const main = kind === undefined || kind === 'main';
  if (!main) return follow(f, kind); // subagents, compaction and workflows run on the session's tier
  if (kind === undefined && headers['user-agent']?.startsWith('claude-cli'))
    warn('Claude Code requests carry no request class. Set CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 so background calls are recognized.');

  const pin = header(headers, 'x-jev-tier') ?? env.JEV_ROUTER_TIER;
  if (pin && !cfg.tiers.includes(pin))
    warn(`Ignoring unknown tier pin ${JSON.stringify(pin.slice(0, 40))}. Known tiers: ${cfg.tiers.join(', ')}.`);
  if (pin && cfg.tiers.includes(pin)) return remember(f, pin, 'pinned', { pinned: true, clientModel: entry?.clientModel ?? body.model });

  // /model in Claude Code changes the requested model; follow the user's explicit switch.
  const family = MODEL_FAMILIES.find((m) => body.model?.includes(m));
  const previousFamily = MODEL_FAMILIES.find((m) => entry?.clientModel?.includes(m));
  const familyTier = family === undefined ? undefined : cfg.modelPins[family];
  if (
    cfg.pinOnModelChange &&
    entry &&
    family &&
    previousFamily &&
    family !== previousFamily &&
    familyTier !== undefined &&
    cfg.tiers.includes(familyTier)
  ) {
    return remember(f, familyTier, `client-model:${family}`, { clientModel: body.model, turns: turns.length });
  }
  return undefined;
}

/**
 * Rules that settle a request by where its session stands: a tier tag, a request that isn't a
 * new human turn (a tool loop keeps the session's tier), sticky mode, and running without Jev.
 * @param {Facts} f
 * @param {boolean} jevConfigured
 * @param {(message: string) => void} warn
 * @returns {Decision | undefined}
 */
function settleByTurn(f, jevConfigured, warn) {
  const { cfg, body, entry, turns, latest } = f;
  const newTurn = latest && (!entry || turns.length > (entry.turns ?? 0));
  const shrank = entry && turns.length < (entry.turns ?? 0); // compaction or a fork: the cache is cold anyway
  const tag = newTurn && latest.text ? tierTag(latest.text, cfg.tiers) : undefined;
  if (tag) return remember(f, tag, 'tag', { clientModel: entry?.clientModel ?? body.model, turns: turns.length });
  if (!newTurn && entry) {
    return {
      ...follow(f, shrank ? 'sticky:history-shrank' : 'sticky'),
      remember: shrank ? { ...entry, turns: turns.length, freshNext: true } : undefined,
    };
  }
  // Unknown session in the middle of a tool loop (a restart without a state file): hold the
  // default tier without pinning, and let the next human turn decide.
  if (!newTurn) return remember(f, cfg.defaultTier, 'no-prompt', { provisional: true, turns: turns.length });

  if (entry && !f.fresh && cfg.policy.mode === 'sticky') return follow(f, 'sticky');
  if (!jevConfigured) {
    warn('No Jev channel has a key, so every session uses the default tier. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY.');
    return entry ? follow(f, 'no-jev') : remember(f, cfg.defaultTier, 'no-jev', { turns: turns.length, clientModel: body.model });
  }
  return undefined;
}

/**
 * Jev failed. An ongoing session keeps its tier. A new or provisional one keeps its provisional
 * tier (a new one gets the default tier) and stays provisional, so that Jev is asked again on the
 * next turn, up to policy.maxProvisional times.
 * @param {Facts} f
 * @param {JevFailure} answer
 * @returns {Decision}
 */
function afterJevFailure(f, answer) {
  const { cfg, body, entry, turns } = f;
  const { policy } = cfg;
  /** @type {JevInfo} */
  const jevInfo = { ok: false, ms: answer.ms, error: answer.error };
  if (answer.aborted) return { ...follow(f, 'client-aborted'), jev: jevInfo };
  if (entry && !entry.provisional) return { ...follow(f, 'fallback:keep'), jev: jevInfo, remember: { ...entry, turns: turns.length } };
  const attempts = (entry?.attempts ?? 0) + 1;
  const provisional = attempts < policy.maxProvisional;
  const trustedOnly = f.trustedOnly || (policy.failClosed && provisional);
  return {
    ...remember(f, entry?.tier ?? cfg.defaultTier, 'fallback:default', {
      provisional,
      attempts,
      turns: turns.length,
      clientModel: entry?.clientModel ?? body.model,
      trustedOnly,
    }),
    trustedOnly,
    jev: jevInfo,
  };
}

/**
 * Jev answered: the policy turns its probabilities into a tier, relative to the session's tier
 * when the session goes on.
 * @param {Facts} f
 * @param {JevSuccess} answer
 * @param {Record<string, JevOption>} options
 * @returns {Decision}
 */
function afterJevAnswer(f, answer, options) {
  const { cfg, body, entry, turns } = f;
  const ongoing = f.fresh ? undefined : entry;
  const decision = applyPolicy({
    answer,
    tiers: cfg.tiers,
    options,
    policy: policyFor(cfg.policy, answer.thresholds),
    reference: ongoing ? ongoing.tier : cfg.defaultTier,
    current: ongoing?.tier,
  });
  /** @type {JevInfo} */
  const jevInfo = {
    ok: true,
    channel: answer.channel,
    model: answer.model,
    requestId: answer.requestId,
    ms: answer.ms,
    inputTokens: answer.inputTokens,
    choice: answer.choice,
    probabilities: answer.probabilities,
    tiers: decision.byTier,
    sensitive: answer.sensitive,
    claim: answer.claim,
    hardened: answer.hardened || undefined,
  };
  return {
    ...remember(f, decision.tier, decision.reason, { turns: turns.length, clientModel: entry?.clientModel ?? body.model }),
    jev: jevInfo,
    secrets: f.secrets || undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Requests and responses

/**
 * Stores what the decision changed about the session, and the human turn where the current
 * provider took over: signed reasoning from before that point came from another provider and
 * must not be sent back to this one.
 * @param {SessionStore} sessions
 * @param {Decision} decision
 * @param {{ host: string, main: boolean, countOnly: boolean }} route the upstream host, and what the request is
 * @returns {SessionEntry | undefined} the session's entry now
 */
function storeDecision(sessions, decision, { host, main, countOnly }) {
  const stored = sessions.get(decision.key.id);
  let entry = decision.remember ? { ...stored, ...decision.remember } : stored;
  let changed = Boolean(decision.remember);
  // A secret in a human turn keeps the session on trusted upstreams for good, whichever rule
  // decided this request: the secret stays in the history that every later request carries.
  if (decision.trustedOnly && entry && !entry.trustedOnly) {
    entry = { ...entry, trustedOnly: true };
    changed = true;
  }
  if (main && !countOnly && decision.tier !== 'side' && entry?.lastHost && entry.lastHost !== host && decision.latestText !== undefined) {
    const anchor = sha(decision.latestText).slice(0, 16);
    if (entry.anchor !== anchor) {
      entry = { ...entry, anchor };
      changed = true;
    }
  }
  if (entry && changed) entry = sessions.set(decision.key.id, entry);
  sessions.touch(decision.key.id);
  return entry;
}

/**
 * The output limits of the Claude models the shipped configs use, measured on 2026-09-24. A client
 * sizes `max_tokens` for the model it thinks it talks to: Claude Code asks Opus 5.5 for 128000, which
 * Haiku 4.5 rejects above 64000. A target's `maxOutputTokens` overrides this table.
 * @type {Array<[RegExp, number]>}
 */
const OUTPUT_LIMITS = [
  [/^claude-haiku-4-5\b/, 64000],
  [/^claude-(sonnet-5|opus-5-5|fable-5-1)\b/, 128000],
];

/**
 * The most output tokens a target's model accepts, when known.
 * @param {Target} target
 * @returns {number | undefined}
 */
function outputLimit(target) {
  return target.maxOutputTokens ?? OUTPUT_LIMITS.find(([pattern]) => pattern.test(target.model))?.[1];
}

/**
 * Lowers a requested output larger than `limit` to it, and keeps a thinking budget below it.
 * @param {RequestBody} body
 * @param {number | undefined} limit
 * @returns {{ body: RequestBody, capped?: number }}
 */
function capOutput(body, limit) {
  if (limit === undefined) return { body };
  for (const field of ['max_tokens', 'max_output_tokens']) {
    const asked = body[field];
    if (typeof asked !== 'number' || asked <= limit) continue;
    /** @type {RequestBody} */
    const capped = { ...body, [field]: limit };
    const thinking = /** @type {{ budget_tokens?: unknown } | undefined} */ (capped.thinking);
    if (typeof thinking?.budget_tokens === 'number' && thinking.budget_tokens >= limit)
      capped.thinking = { ...thinking, budget_tokens: limit - 1 };
    return { body: capped, capped: limit };
  }
  return { body };
}

/**
 * The models that take `role: "system"` messages inside `messages`. Claude Code sends them to the
 * Claude 5 family it believes it talks to; Haiku 4.5 answers "role 'system' is not supported on this
 * model", so every other model gets them folded (measured on 2026-09-24).
 */
const NATIVE_SYSTEM_MESSAGES = /^claude-(sonnet-5|opus-5-5|fable-5-1)\b/;

/** @param {string} text */
const reminder = (text) => (text.includes('<system-reminder>') ? text : `<system-reminder>\n${text}\n</system-reminder>`);

/**
 * A message's content as a list of blocks.
 * @param {Item['content']} content
 * @returns {ContentBlock[]}
 */
const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

/**
 * Applies a system message's tool addition to the request's tools, for a model that can't take tool
 * changes mid-conversation: a definition joins `tools`, and a reference to a deferred tool loads it.
 * Claude Code writes these as `{ type: 'tool_addition', tool: { type: 'tool_definition', definition } }`
 * or `{ type: 'tool_addition', tool: { type: 'tool_reference', name } }`.
 * @param {unknown[]} tools
 * @param {ContentBlock} block
 * @returns {unknown[]}
 */
function addTool(tools, block) {
  const tool = isRecord(block.tool) ? block.tool : undefined;
  const definition = tool?.type === 'tool_definition' && isRecord(tool.definition) ? tool.definition : undefined;
  if (definition) return tools.some((t) => isRecord(t) && t.name === definition.name) ? tools : [...tools, definition];
  if (tool?.type !== 'tool_reference') return tools;
  return tools.map((t) =>
    isRecord(t) && t.name === tool.name && t.defer_loading
      ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'defer_loading'))
      : t,
  );
}

/**
 * The blocks of a system message that can live in a user message: its text, as `<system-reminder>`.
 * Tool additions go to `tools` instead; tool removals and other system-only blocks have no place
 * outside a system message, and a removed tool simply stays available.
 * @param {ContentBlock[]} content
 * @param {{ tools: unknown[] }} acc collects the tool additions
 * @returns {ContentBlock[]}
 */
function foldableBlocks(content, acc) {
  /** @type {ContentBlock[]} */
  const blocks = [];
  for (const b of content) {
    if ((b.type === 'text' || b.type === 'connector_text') && typeof b.text === 'string')
      blocks.push({ ...b, type: 'text', text: reminder(b.text) });
    else if (b.type === 'tool_addition') acc.tools = addTool(acc.tools, b);
  }
  return blocks;
}

/**
 * Folds each mid-conversation system message into the user message it follows, as `<system-reminder>`
 * text at the end of that message: tool results have to stay first. A system message that doesn't
 * follow a user message becomes one, a directive with no content goes, and tool additions join `tools`.
 * @param {RequestBody} body
 * @returns {{ body: RequestBody, folded?: number }}
 */
function foldSystemMessages(body) {
  const messages = body.messages;
  const count = Array.isArray(messages) ? messages.filter((m) => m?.role === 'system').length : 0;
  if (!messages || count === 0) return { body };
  const acc = { tools: Array.isArray(body.tools) ? body.tools : [] };
  const before = acc.tools;
  /** @type {Item[]} */
  const out = [];
  for (const message of messages) {
    if (message?.role !== 'system') {
      out.push(message);
      continue;
    }
    const blocks = foldableBlocks(blocksOf(message.content), acc);
    if (blocks.length === 0) continue;
    const previous = out.at(-1);
    if (previous?.role === 'user') out[out.length - 1] = { ...previous, content: [...blocksOf(previous.content), ...blocks] };
    else out.push({ role: 'user', content: blocks });
  }
  /** @type {RequestBody} */
  const folded = { ...body, messages: out };
  if (acc.tools !== before) folded.tools = acc.tools;
  return { body: folded, folded: count };
}

/**
 * Beta flags a model rejects, though a client asks for them for the model it thinks it talks to:
 * Claude Code sends the 1M-context beta once its model has a 1M window, and Haiku 4.5 answers "The
 * long context beta is not yet available for this subscription" (measured on 2026-09-24). A
 * target's `omitBetas` overrides this table.
 * @type {Array<[RegExp, string[]]>}
 */
const REJECTED_BETAS = [[/^claude-haiku-4-5\b/, ['context-1m-2025-08-07']]];

/**
 * @param {Target} target
 * @returns {string[]}
 */
const rejectedBetas = (target) => target.omitBetas ?? REJECTED_BETAS.find(([pattern]) => pattern.test(target.model))?.[1] ?? [];

/**
 * The body a target gets: the model replaced, reasoning another provider signed dropped, secrets
 * redacted for an untrusted target, fields the target rejects left out, the output capped at what
 * the model accepts, and mid-conversation system messages folded for a model that rejects them.
 * @param {RequestBody} body
 * @param {string} text the body as received, for a quick check for secrets
 * @param {Target} target
 * @param {string | undefined} anchor where the current provider took over the conversation
 * @returns {{ body: RequestBody, redacted: number, capped?: number, folded?: number }} `redacted` counts the secrets replaced
 */
function prepareBody(body, text, target, anchor) {
  let outgoing = anchor ? stripForeignReasoning(body, anchor) : body;
  let redacted = 0;
  if (!target.trusted && mayContainSecret(text)) ({ body: outgoing, count: redacted } = redactBody(outgoing));
  outgoing = omitFields({ ...outgoing, model: target.model }, target.omit);
  if (!target.trusted) delete outgoing.metadata;
  const capped = capOutput(outgoing, outputLimit(target));
  const fold = target.foldSystemMessages ?? !NATIVE_SYSTEM_MESSAGES.test(target.model);
  const folded = fold ? foldSystemMessages(capped.body) : { body: capped.body };
  return { body: folded.body, redacted, capped: capped.capped, folded: folded.folded };
}

/**
 * Drops signed reasoning (thinking blocks, encrypted reasoning items) that came before the human turn
 * where the current provider took over. Another provider's signatures are always rejected.
 * @param {RequestBody} body
 * @param {string} anchor
 * @returns {RequestBody}
 */
function stripForeignReasoning(body, anchor) {
  const list = items(body);
  const turns = humanTurns(body);
  const at = turns.find((t) => sha(t.text).slice(0, 16) === anchor)?.index;
  if (at === undefined) return body; // compacted or a different conversation: nothing foreign left in it
  if (Array.isArray(body.input)) return { ...body, input: body.input.filter((item, i) => i >= at || !SIGNED.has(item?.type)) };
  return {
    ...body,
    messages: list.map((m, i) =>
      i >= at || m?.role !== 'assistant' || !Array.isArray(m.content)
        ? m
        : { ...m, content: m.content.filter((b) => !SIGNED.has(b?.type)) },
    ),
  };
}

/**
 * Removes fields a target rejects. Paths may be nested: "output_config.effort".
 * @param {RequestBody} body
 * @param {string[]} [paths]
 * @returns {RequestBody} a copy, or `body` itself when there is nothing to remove
 */
function omitFields(body, paths = []) {
  if (!paths.length) return body;
  const out = structuredClone(body);
  for (const path of paths) {
    const keys = path.split('.');
    const parent = keys.slice(0, -1).reduce(member, /** @type {unknown} */ (out));
    if (isRecord(parent)) delete parent[keys[keys.length - 1]];
  }
  return out;
}

/**
 * A member of a parsed JSON value, or undefined when the value isn't an object.
 * @param {unknown} node
 * @param {string} key
 * @returns {unknown}
 */
function member(node, key) {
  return isRecord(node) ? node[key] : undefined;
}

/**
 * Any object, arrays included, can be read by key.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {unknown} value a parsed body
 * @returns {value is RequestBody}
 */
function isJsonObject(value) {
  return isRecord(value) && value.constructor === Object;
}

/**
 * Sends a request upstream and streams the response back unchanged, hashing it and reading its
 * usage on the way. It throws when the upstream can't be reached; once the response has started,
 * a stream that breaks off is cut for the client as well (so it can't pass for a whole response),
 * and comes back as `broken` with what it delivered.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {Target} target
 * @param {RequestBody} body
 * @param {Record<string, string>} shown the x-jev-* headers for the client
 * @param {AbortSignal} signal
 * @param {Env} env
 * @returns {Promise<{ status: number, bytes: number, sha256: string, usage: Usage | undefined, aborted: boolean, broken: boolean, error?: string }>}
 */
async function forward(req, res, target, body, shown, signal, env) {
  const upstream = await fetch(target.url + req.url, {
    method: 'POST',
    headers: upstreamHeaders(req, target, env),
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  });
  res.writeHead(upstream.status, { ...Object.fromEntries([...upstream.headers].filter(([n]) => !DROP_RESPONSE.has(n))), ...shown });
  const hash = createHash('sha256');
  const tap = new UsageTap(upstream.headers.get('content-type') ?? '');
  let bytes = 0;
  // The start of an error body, for its message in the log.
  /** @type {Buffer[]} */
  const errorHead = [];
  /** @type {string | undefined} */
  let broke;
  try {
    for await (const chunk of upstream.body ?? []) {
      hash.update(chunk);
      tap.push(chunk);
      if (upstream.status >= 400 && bytes < ERROR_HEAD_BYTES) errorHead.push(chunk);
      bytes += chunk.length;
      // A slow client: wait until it takes more, or leaves (the signal aborts on close). A race with
      // once(res, 'close') would leave that listener behind on every wait until the response ends.
      if (!res.write(chunk)) await once(res, 'drain', { signal }).catch(() => undefined);
      if (res.destroyed || signal.aborted) break;
    }
  } catch (err) {
    if (!signal.aborted) broke = `the stream from ${new URL(target.url).host} broke off after ${bytes} bytes: ${failure(err)}`;
  }
  if (broke) res.destroy();
  else res.end();
  const error =
    broke ?? (upstream.status >= 400 ? errorMessage(Buffer.concat(errorHead).subarray(0, ERROR_HEAD_BYTES).toString()) : undefined);
  return {
    status: upstream.status,
    bytes,
    sha256: hash.digest('hex'),
    usage: tap.result(),
    aborted: signal.aborted,
    broken: Boolean(broke),
    error,
  };
}

/**
 * Why a fetch failed, in words. Undici says "fetch failed" or "terminated"; its cause says what
 * happened: a DNS lookup, a refused connection, a TLS handshake, a connection that was reset.
 * @param {unknown} err
 * @returns {string}
 */
function failure(err) {
  const error = err instanceof Error ? err : new Error(String(err));
  const { cause } = /** @type {{ cause?: unknown }} */ (error);
  if (!(cause instanceof Error)) return error.message;
  const detail = describeCause(cause);
  return ['fetch failed', 'terminated'].includes(error.message) ? detail : `${error.message}: ${detail}`;
}

/**
 * @param {Error} cause the socket, DNS or TLS error behind a fetch failure
 * @returns {string}
 */
function describeCause(cause) {
  // One error per address tried, as for localhost on both IPv6 and IPv4.
  if (cause instanceof AggregateError && cause.errors.length) return cause.errors.map((e) => String(e?.message ?? e)).join(', ');
  const { code, reason } = /** @type {{ code?: unknown, reason?: unknown }} */ (cause);
  const tag = typeof code === 'string' && !cause.message.includes(code) ? ` (${code})` : '';
  // An OpenSSL error's message is a raw error string; its reason is the part people read.
  if (typeof reason === 'string') return `TLS error: ${reason}${tag}`;
  return `${cause.message}${tag}`;
}

/** How much of an error body is read for its message. */
const ERROR_HEAD_BYTES = 4096;

/**
 * The message of an upstream error body: `error.message` in Anthropic's and OpenAI's shape, else the
 * start of the body. Error messages name fields and limits, not prompt text.
 * @param {string} text
 * @returns {string}
 */
function errorMessage(text) {
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === 'string') return message.slice(0, 300);
  } catch {
    // not JSON: the start of the body below
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * The headers an upstream gets: no hop-by-hop headers and none of the client's credentials or the
 * router's controls, only content headers for an untrusted target, and the target's key.
 * @param {IncomingMessage} req
 * @param {Target} target
 * @param {Env} env
 * @returns {Record<string, string | string[]>}
 */
function upstreamHeaders(req, target, env) {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROP_REQUEST.has(name)) continue;
    if (!target.trusted && !MINIMAL_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  headers['accept-encoding'] = 'identity'; // relay upstream bytes as they are
  const drop = rejectedBetas(target);
  if (drop.length > 0 && headers['anthropic-beta'] !== undefined) {
    const kept = String(headers['anthropic-beta'])
      .split(',')
      .map((beta) => beta.trim())
      .filter((beta) => beta && !drop.includes(beta));
    if (kept.length > 0) headers['anthropic-beta'] = kept.join(',');
    else delete headers['anthropic-beta'];
  }
  const key = target.keyEnv ? env[target.keyEnv] : undefined;
  if (key && target.auth === 'bearer') headers.authorization = `Bearer ${key}`;
  else if (key) headers['x-api-key'] = key;
  else if (target.clientAuth) {
    // no router key: pass the client's own login (for example claude.ai) to its provider only
    for (const name of ['authorization', 'x-api-key']) if (req.headers[name]) headers[name] = req.headers[name];
  }
  return headers;
}

/**
 * Reads a whole request body.
 * @param {IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer | null>} null when the body is larger than `limit` bytes
 */
async function readBody(req, limit) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    // keep reading past the limit, so the 413 can still be sent
    size += chunk.length;
    if (size > limit) {
      over = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  return over ? null : Buffer.concat(chunks);
}

/**
 * Compares a secret in constant time.
 * @param {unknown} a
 * @param {unknown} b
 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** @param {number} since a performance.now() timestamp */
const elapsed = (since) => Math.round(performance.now() - since);

/**
 * Answers with an error the router raises itself, in the error shape of the client's own provider.
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {Surface} [surface] the client's API; without one, the Anthropic shape
 * @param {Record<string, string>} [headers]
 * @returns {undefined}
 */
function fail(res, status, message, surface, headers = {}) {
  const type = ERROR_TYPES[status] ?? 'api_error';
  const body = surface === 'openai' ? { error: { message, type, param: null, code: null } } : { type: 'error', error: { type, message } };
  res.writeHead(status, { 'content-type': 'application/json', ...(status < 500 ? { 'x-should-retry': 'false' } : {}), ...headers });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------------------------
// Report

/**
 * One log line as a log entry, or undefined for a line that isn't one.
 * @param {string} line
 * @returns {LogEntry | undefined}
 */
function parseEntry(line) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  // The log holds the router's own entries; a stray `null` line must not abort the report.
  return value && typeof value === 'object' ? /** @type {LogEntry} */ (value) : undefined;
}

/**
 * Adds one response to its model's totals.
 * @param {ModelTotals} m
 * @param {{ usage?: Usage, cost_usd?: number }} e
 */
function tally(m, e) {
  m.requests += 1;
  if (e.usage) {
    m.input += e.usage.input;
    m.cache_read += e.usage.cacheRead;
    m.output += e.usage.output;
  }
  if (e.cost_usd !== undefined) m.cost_usd += e.cost_usd;
}

/**
 * Where a config routes, for the `config` log entry that `jev-router ui` draws its graph from: model
 * names and upstream hosts, never keys or the names of their variables.
 * @param {Config} cfg
 * @returns {ConfigSummary}
 */
export function describeConfig(cfg) {
  /** @type {ConfigSummary['surfaces']} */
  const surfaces = {};
  for (const [surface, targets] of Object.entries(cfg.surfaces)) {
    surfaces[surface] = Object.fromEntries(
      Object.entries(targets).map(([name, target]) => [
        name,
        { model: target.model, upstream: new URL(target.url).host, trusted: Boolean(target.trusted) },
      ]),
    );
  }
  return {
    version: VERSION,
    mode: cfg.policy.mode,
    tiers: cfg.tiers,
    defaultTier: cfg.defaultTier,
    options: Object.fromEntries(Object.entries(cfg.jev.options).map(([name, option]) => [name, option.tier])),
    accept: cfg.policy.accept,
    escalationCeiling: cfg.policy.escalationCeiling,
    sensitiveOverride: cfg.policy.sensitiveOverride,
    claimGuard: cfg.policy.claimGuard,
    surfaces,
    jev: { channels: cfg.jev.channels.map((c) => ({ name: c.name, model: c.model, host: new URL(c.baseUrl).host })) },
  };
}

/**
 * `jev-router report [log.jsonl]`: requests, spend, savings against the baseline, and Jev health.
 * @param {Iterable<string>} lines the log's lines; lines that aren't log entries are skipped
 * @returns {Report}
 */
export function report(lines) {
  /** @type {Map<string, ModelTotals>} */
  const models = new Map();
  /** @type {number[]} */
  const jevMs = [];
  /** @type {Set<string>} */
  const sessions = new Set();
  let requests = 0;
  let jevCalls = 0;
  let fallbacks = 0;
  let jevInput = 0;
  let cost = 0;
  let baseline = 0;
  let unpriced = 0;
  for (const line of lines) {
    const e = parseEntry(line);
    if (e?.event === 'route') {
      requests += 1;
      sessions.add(e.session);
      if (e.jev) {
        jevCalls += 1;
        if (e.jev.ok) {
          jevMs.push(e.jev.ms);
          jevInput += e.jev.inputTokens ?? 0;
        } else fallbacks += 1;
      }
    } else if (e?.event === 'done' && e.model) {
      const m = models.get(e.model) ?? { requests: 0, cost_usd: 0, input: 0, cache_read: 0, output: 0 };
      tally(m, e);
      if (e.cost_usd !== undefined) cost += e.cost_usd;
      else if (e.usage) unpriced += 1;
      baseline += e.baseline_usd ?? e.cost_usd ?? 0;
      models.set(e.model, m);
    }
  }
  jevMs.sort((a, b) => a - b);
  /** @param {number} p */
  const pct = (p) => (jevMs.length ? jevMs[Math.min(jevMs.length - 1, Math.floor(p * jevMs.length))] : null);
  /** @type {(x: number, d?: number) => number} */
  const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    requests,
    sessions: sessions.size,
    models: Object.fromEntries([...models].map(([m, v]) => [m, { ...v, cost_usd: round(v.cost_usd) }])),
    cost_usd: round(cost),
    baseline_usd: round(baseline),
    saved_usd: round(baseline - cost),
    unpriced_responses: unpriced,
    jev: {
      calls: jevCalls,
      fallbacks,
      fallback_rate: jevCalls ? round(fallbacks / jevCalls, 3) : 0,
      p50_ms: pct(0.5),
      p95_ms: pct(0.95),
      cost_usd: round(jevInput * 0.042e-6, 6),
    },
  };
}
