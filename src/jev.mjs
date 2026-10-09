// Everything that involves Jev, TypeSafe's System One decision model: the state it sees, the
// questions it answers, the channels it's reached through, and the policy that turns its
// probabilities into a tier. Jev's answer is advice; the rules that must hold stay in code.
import { clip, describeCode, harness, lastAssistantText, recentTools } from './messages.mjs';
import { directFetch } from './net.mjs';
import { scrub } from './secrets.mjs';

/**
 * @import { ChannelStats, ChannelThresholds, Env, FetchLike, IncomingHttpHeaders, JevAnswer, JevChannel, JevConfig,
 *   JevOption, JevQuestions, JevState, Policy, PolicyDecision, PolicyInput, RequestBody, SystemOneResponse, Turn } from './types.js'
 */

/**
 * A channel with its key read from the environment. `local` channels are loopback and keyless:
 * nothing in the environment is sent to them.
 * @typedef {Omit<JevChannel, 'keyEnv'> & { key: string | undefined, local: boolean }} LiveChannel
 */

/**
 * @typedef {object} CallSuccess
 * @property {true} ok
 * @property {string} [model]
 * @property {string} [requestId]
 * @property {number} [inputTokens]
 * @property {string} [choice]
 * @property {Record<string, number>} probabilities
 * @property {number} [sensitive]
 * @property {number} [claim]
 */

/**
 * @typedef {object} CallFailure
 * @property {false} ok
 * @property {undefined} [aborted]
 * @property {string} error
 * @property {number} [status]
 * @property {boolean} [waf] blocked by the edge firewall
 * @property {number} [retryAfterMs]
 * @property {boolean} [timeout]
 * @property {boolean} [network]
 */

/** @typedef {CallSuccess | CallFailure | { ok: false, aborted: true }} CallResult */

/**
 * The state Jev sees: the request and a little context, never tool output, file contents or the
 * system prompt. Secrets are scrubbed before truncation, and code blocks become a one-line
 * description unless `jev.stripCode` is false.
 * @param {object} request
 * @param {RequestBody} request.body
 * @param {IncomingHttpHeaders} request.headers
 * @param {Turn[]} request.turns the human turns; the last one is the request
 * @param {number} request.bodyBytes the body's size, which tells how long the session is
 * @param {Pick<JevConfig, 'requestChars' | 'stripCode'>} request.jev
 * @returns {JevState}
 */
export function buildState({ body, headers, turns, bodyBytes, jev }) {
  /** @type {(text: string, max: number) => string} */
  const prepare = (text, max) => {
    const scrubbed = scrub(text).text;
    return clip(jev.stripCode ? describeCode(scrubbed) : scrubbed, max);
  };
  const latest = turns[turns.length - 1];
  const earlier = turns
    .slice(-3, -1)
    .map((t) => prepare(t.text, 600))
    .filter(Boolean);
  // A short "yes, go ahead" inherits the work it approves.
  const previous = latest.text.split(/\s+/).filter(Boolean).length < 30 ? lastAssistantText(body) : '';
  const tokens = bodyBytes / 4;
  const depth =
    turns.length === 1
      ? 'new session'
      : tokens < 20000
        ? 'early (under 20k tokens)'
        : tokens < 100000
          ? 'mid (20k to 100k tokens)'
          : 'long (over 100k tokens)';
  const tools = recentTools(body);
  // Built in one literal, in the order Jev reads the keys.
  return {
    request: latest.text ? prepare(latest.text, jev.requestChars) : `(the user sent ${latest.images} image(s) and no text)`,
    ...(earlier.length ? { recent_user_turns: earlier } : {}),
    ...(previous ? { last_assistant_message: prepare(previous, 800) } : {}),
    session: { harness: harness(headers), depth, ...(tools ? { recent_tools: tools } : {}) },
  };
}

/**
 * The retry after a firewall block drops everything that looks like a command, path or URL.
 * @template T
 * @param {T} state
 * @returns {T} a copy with every string hardened
 */
export function hardenState(state) {
  /** @param {string} text */
  const scrubHard = (text) =>
    text
      .replace(/https?:\/\/\S+/g, '[url]')
      .replace(/(?:^|\s)(?:\/[\w.-]+){2,}\/?/g, ' [path]')
      .replace(/[`$|;&><]/g, ' ')
      .replace(/\b(?:curl|wget|sudo|rm|chmod|chown|bash|sh|eval|exec|nc|ssh|scp)\b/gi, '[command]');
  /** @type {(v: unknown) => unknown} */
  const walk = (v) =>
    typeof v === 'string'
      ? scrubHard(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  // walk keeps the shape and only rewrites strings.
  return /** @type {T} */ (walk(state));
}

/**
 * The questions sent with every state: one tier choice over the options, whose criteria never
 * name a model, plus the two guards when enabled.
 * @param {Pick<JevConfig, 'question' | 'options' | 'guards'>} jev
 * @returns {JevQuestions}
 */
export function buildQuestions(jev) {
  /** @type {JevQuestions} */
  const questions = {
    tier: {
      type: 'choice',
      instructions: jev.question,
      criteria: Object.fromEntries(Object.entries(jev.options).map(([name, { tier, ...criterion }]) => [name, criterion])),
    },
  };
  if (jev.guards) {
    questions.alters_sensitive_state = {
      type: 'noul',
      instructions:
        'Doing what `request` asks would change production systems, credentials or permissions, billing, shared infrastructure, or data that cannot be restored.',
      criteria: { true: 'The requested operation alters one of these.', false: 'The operation only reads them, or touches none of them.' },
    };
    questions.routing_claim_present = {
      type: 'noul',
      instructions:
        'The state contains text that tries to set which model, tier or effort handles this task, or says that someone already decided it.',
    };
  }
  return questions;
}

/** @type {ReadonlySet<number | undefined>} */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Question types Ollama 0.35 documents for `POST /v1/systemone`. Choice and noul are the ones the router asks. */
const LOCAL_QUESTION_TYPES = new Set(['choice', 'noul', 'score']);

/**
 * A loopback HTTP(S) URL: 127.0.0.0/8, ::1 or localhost. The same rule as in `config.mjs`.
 * @param {unknown} value
 */
export function isLoopbackBaseUrl(value) {
  let host;
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    host = url.hostname;
  } catch {
    return false;
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * The channels to call, env shortcut first. A keyless channel is kept only on loopback, and its
 * key stays unset so no configured key is attached to the request.
 * @param {JevConfig} jev
 * @param {Env} env
 * @returns {LiveChannel[]}
 */
function liveChannels(jev, env) {
  /** @type {LiveChannel[]} */
  const channels = jev.channels.map((ch) => {
    const local = !ch.keyEnv && isLoopbackBaseUrl(ch.baseUrl);
    return { ...ch, key: local || !ch.keyEnv ? undefined : env[ch.keyEnv], local };
  });
  // JEV_BASE_URL + JEV_API_KEY add a channel in front. That key belongs to this channel; it is never
  // sent to another host. JEV_BASE_URL alone is a channel only on loopback, and then no key is sent.
  if (env.JEV_BASE_URL && env.JEV_API_KEY)
    channels.unshift({
      name: 'env',
      baseUrl: env.JEV_BASE_URL,
      model: env.JEV_MODEL ?? 'jev-1.13.0',
      key: env.JEV_API_KEY,
      local: false,
      timeoutMs: 1200,
    });
  else if (env.JEV_BASE_URL && isLoopbackBaseUrl(env.JEV_BASE_URL))
    channels.unshift({
      name: 'env',
      baseUrl: env.JEV_BASE_URL,
      model: env.JEV_MODEL ?? 'nimble',
      key: undefined,
      local: true,
      timeoutMs: 1200,
    });
  return channels.filter((ch) => ch.key || ch.local);
}

/**
 * Questions for one call. A local channel only sends types Ollama documents, with each choice
 * criterion written out as the description string that API requires. An unsupported type fails
 * the channel, the same way a failed call does: the next channel decides. Never throws.
 * @param {JevQuestions} questions
 * @param {boolean} local
 * @returns {{ ok: true, questions: JevQuestions } | { ok: false, error: string }}
 */
export function prepareQuestions(questions, local) {
  if (!local) return { ok: true, questions };
  /** @type {string[]} */
  const unsupported = [];
  /** @type {Record<string, NonNullable<JevQuestions[keyof JevQuestions]>>} */
  const prepared = {};
  for (const [name, question] of Object.entries(questions)) {
    if (!question || !LOCAL_QUESTION_TYPES.has(question.type)) {
      unsupported.push(`${name} (${question?.type ?? 'missing'})`);
      continue;
    }
    prepared[name] = flattenQuestion(question);
  }
  if (unsupported.length || prepared.tier?.type !== 'choice')
    return { ok: false, error: `unsupported question type: ${unsupported.join(', ') || 'tier'}` };
  return { ok: true, questions: /** @type {JevQuestions} */ (/** @type {unknown} */ (prepared)) };
}

/**
 * @param {NonNullable<JevQuestions[keyof JevQuestions]>} question
 * @returns {NonNullable<JevQuestions[keyof JevQuestions]>}
 */
function flattenQuestion(question) {
  if (!question.criteria) return question;
  if (question.type === 'noul') {
    return {
      ...question,
      criteria: { true: criterionText(question.criteria.true) ?? '', false: criterionText(question.criteria.false) ?? '' },
    };
  }
  return {
    ...question,
    criteria: Object.fromEntries(Object.entries(question.criteria).map(([name, value]) => [name, criterionText(value)])),
  };
}

/**
 * One criterion as a description. Ollama rejects the structured object TypeSafe accepts.
 * @param {unknown} value
 * @returns {string | null}
 */
function criterionText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('; ');
  if (typeof value !== 'object') return String(value);
  const rec = /** @type {Record<string, unknown>} */ (value);
  /** @type {string[]} */
  const parts = [];
  if (typeof rec.what === 'string') parts.push(rec.what);
  if (Array.isArray(rec.examples)) parts.push(`Examples: ${rec.examples.join('; ')}.`);
  if (typeof rec.not_for === 'string') parts.push(`Not for: ${rec.not_for}`);
  for (const [key, item] of Object.entries(rec)) {
    if (key === 'what' || key === 'examples' || key === 'not_for') continue;
    parts.push(`${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`);
  }
  return parts.join(' ');
}

/**
 * A failed call's result with the channel's key taken out of its error: an error can quote what was
 * sent, and a server can echo it back.
 * @template {{ ok: boolean, error?: string }} R
 * @param {R} result
 * @param {string | undefined} key
 * @returns {R}
 */
function withoutKey(result, key) {
  if (result.ok || !key || !result.error?.includes(key)) return result;
  return { ...result, error: result.error.replaceAll(key, '<key>') };
}
/** @type {(ms: number) => Promise<void>} */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A small state in the shape the router sends, for one call that checks a Jev key: `doctor --live`
 * and `setup` make it, and it costs about $0.00003.
 * @type {JevState}
 */
export const SAMPLE_STATE = {
  request: 'Rename the variable tmp to total in utils.py.',
  session: { harness: 'Claude Code', depth: 'new session' },
};

/**
 * Talks to one or more System One channels (TypeSafe, OpenRouter, Vercel AI Gateway, a local
 * Ollama, or another compatible server). Each hosted channel has its own key, bound to its own
 * host. A loopback channel may have none, and then no key is sent. The whole decision has one
 * deadline; within it a channel gets one retry, and a failing channel is skipped for a while.
 */
export class JevClient {
  /**
   * @param {JevConfig} jev
   * @param {Env} env where the channel keys are read from
   * @param {{ fetchImpl?: FetchLike }} [options] a fetch for every channel; without one, loopback
   *   channels skip any proxy and the rest use the global fetch
   */
  constructor(jev, env, { fetchImpl } = {}) {
    this.jev = jev;
    this.fetch = fetchImpl;
    /** @type {Map<string, ChannelStats>} */
    this.stats = new Map();
    this.channels = liveChannels(jev, env);
    for (const ch of this.channels) this.stats.set(ch.name, { calls: 0, errors: 0, lastError: null, openUntil: 0 });
  }

  /** At least one channel can be called: it has a key, or it is a keyless loopback channel. */
  get configured() {
    return this.channels.length > 0;
  }

  /**
   * Counters per channel, and whether its circuit breaker is open.
   * @returns {Record<string, ChannelStats & { open: boolean }>}
   */
  health() {
    return Object.fromEntries([...this.stats].map(([name, s]) => [name, { ...s, open: s.openUntil > Date.now() }]));
  }

  /**
   * Asks the channels in order until one answers. Never throws: a failure is an answer too.
   * @param {JevState} state
   * @param {{ signal?: AbortSignal }} [options] `signal` aborts when the client goes away
   * @returns {Promise<JevAnswer>}
   */
  async decide(state, { signal } = {}) {
    const started = performance.now();
    const deadline = started + this.jev.deadlineMs;
    /** @type {string[]} */
    const errors = [];
    for (const ch of this.channels) {
      if (signal?.aborted) break;
      const answer = await this.#ask(ch, state, { started, deadline, signal, errors });
      if (answer) return answer;
    }
    const ms = Math.round(performance.now() - started);
    // A client that left before or between calls is not a Jev failure.
    if (signal?.aborted) return { ok: false, aborted: true, error: 'client went away', ms };
    return { ok: false, error: errors.join('; ') || 'no Jev channel is configured', ms };
  }

  /**
   * One channel's turn: up to three calls while the deadline allows. Resolves to undefined when
   * the next channel should be tried.
   * @param {LiveChannel} ch
   * @param {JevState} state
   * @param {{ started: number, deadline: number, signal?: AbortSignal, errors: string[] }} run
   * @returns {Promise<JevAnswer | undefined>}
   */
  async #ask(ch, state, { started, deadline, signal, errors }) {
    const stat = /** @type {ChannelStats} */ (this.stats.get(ch.name)); // the constructor adds stats for every channel
    if (stat.openUntil > Date.now()) {
      errors.push(`${ch.name}: skipped (failing)`);
      return undefined;
    }
    let payloadState = state;
    let hardened = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = deadline - performance.now();
      if (remaining < 150 || signal?.aborted) break;
      stat.calls += 1;
      const result = withoutKey(await this.#call(ch, payloadState, Math.min(ch.timeoutMs, remaining), signal), ch.key);
      if (result.ok)
        return { ...result, channel: ch.name, thresholds: ch.thresholds, ms: Math.round(performance.now() - started), hardened };
      if (result.aborted) return { ok: false, aborted: true, error: 'client went away', ms: Math.round(performance.now() - started) };
      stat.errors += 1;
      stat.lastError = result.error;
      errors.push(`${ch.name}: ${result.error}`);
      if (result.waf && !hardened) {
        payloadState = hardenState(state);
        hardened = true;
        continue;
      }
      const wait = retryDelay(result, stat, attempt, deadline);
      if (wait === undefined) break;
      await sleep(wait);
    }
    return undefined;
  }

  /**
   * One System One request. Never throws: every failure comes back as a result.
   * @param {LiveChannel} ch
   * @param {JevState} state
   * @param {number} timeoutMs
   * @param {AbortSignal} [signal]
   * @returns {Promise<CallResult>}
   */
  async #call(ch, state, timeoutMs, signal) {
    const prepared = prepareQuestions(buildQuestions(this.jev), ch.local);
    // An unsupported question fails this channel, and the next one decides.
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let res;
    let text;
    const fetchImpl = this.fetch ?? (isLoopbackBaseUrl(ch.baseUrl) ? directFetch : globalThis.fetch);
    try {
      res = await fetchImpl(`${ch.baseUrl.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any(signals),
        headers: channelHeaders(ch),
        body: JSON.stringify({ model: ch.model, state, questions: prepared.questions }),
      });
      text = await res.text(); // read the whole body before parsing, so an abort mid-body is just an error
    } catch (err) {
      if (signal?.aborted) return { ok: false, aborted: true };
      // fetch rejects with the timeout signal's DOMException, or a TypeError whose cause has the socket error code.
      const error = /** @type {Error & { cause?: { code?: string } }} */ (err);
      const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      // A header fetch can't send is quoted whole in the message: say what's wrong without it.
      const header = !error.cause && /header/i.test(error.message);
      return {
        ok: false,
        timeout,
        network: !timeout,
        error: timeout
          ? `timeout after ${timeoutMs} ms`
          : header
            ? 'the key has characters an HTTP header cannot carry'
            : (error.cause?.code ?? error.message),
      };
    }
    if (!res.ok) return httpFailure(res, text);
    /** @type {SystemOneResponse | null} */
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, error: 'response is not JSON' };
    }
    const tier = parsed?.answers?.tier;
    /** @type {readonly unknown[]} */
    const options = Object.keys(this.jev.options);
    if (!parsed?.answers || !tier || (!tier.probabilities && !options.includes(tier.choice)))
      return { ok: false, status: res.status, error: 'response has no tier answer' };
    // A valid choice without probabilities counts as certain.
    const probabilities = tier.probabilities ?? { [String(tier.choice)]: 1 };
    return {
      ok: true,
      model: parsed.model ?? ch.model,
      requestId: res.headers.get('x-typesafe-request-id') ?? res.headers.get('x-request-id') ?? parsed.id,
      inputTokens: parsed.usage?.input_tokens,
      choice: tier.choice,
      probabilities,
      sensitive: parsed.answers.alters_sensitive_state?.noul,
      claim: parsed.answers.routing_claim_present?.noul,
    };
  }
}

/**
 * The failure for a non-2xx response, with the error message the body carries.
 * @param {Response} res
 * @param {string} text the response body
 * @returns {CallFailure}
 */
function httpFailure(res, text) {
  const type = res.headers.get('content-type') ?? '';
  // A 403 with an HTML body comes from the edge firewall, not from TypeSafe's API.
  const waf = res.status === 403 && (type.includes('text/html') || text.trimStart().startsWith('<'));
  const retryAfter = Number(res.headers.get('retry-after'));
  let detail = '';
  try {
    /** @type {{ error?: { message?: string }, detail?: string | { message?: string } }} */
    const err = JSON.parse(text);
    detail =
      (typeof err.error === 'string' ? err.error : err.error?.message) ??
      (typeof err.detail === 'string' ? err.detail : (err.detail?.message ?? JSON.stringify(err.detail ?? '')));
  } catch {
    detail = waf ? 'firewall block' : text.slice(0, 120);
  }
  return {
    ok: false,
    status: res.status,
    waf,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    // It ends up in every route entry of the turn and in /healthz, so a long error body is cut.
    error: `HTTP ${res.status} ${String(detail).slice(0, 200)}`.trim(),
  };
}

/**
 * After a failed call: opens the channel's circuit breaker when a retry can't help (30 s after a
 * timeout or network error, 5 min after an auth or billing error), and returns how long to wait
 * before the one retry, or undefined to move on to the next channel.
 * @param {CallFailure} result
 * @param {ChannelStats} stat
 * @param {number} attempt
 * @param {number} deadline
 * @returns {number | undefined}
 */
function retryDelay(result, stat, attempt, deadline) {
  if (result.timeout || result.network) {
    stat.openUntil = Date.now() + 30000;
    return undefined;
  }
  if (result.status === 401 || result.status === 402 || result.status === 403) {
    stat.openUntil = Date.now() + 300000;
    return undefined;
  }
  if (!RETRYABLE.has(result.status) || attempt > 0) return undefined;
  const wait = Math.min(result.retryAfterMs ?? 150, deadline - performance.now() - 200);
  return wait < 0 ? undefined : wait;
}

/**
 * Headers for one call. A local channel gets no `Authorization` header, so a key configured for
 * another channel cannot ride along.
 * @param {LiveChannel} ch
 * @returns {Record<string, string>}
 */
function channelHeaders(ch) {
  return ch.key && !ch.local
    ? { authorization: `Bearer ${ch.key}`, 'content-type': 'application/json' }
    : { 'content-type': 'application/json' };
}

/**
 * Policy probabilities for one channel's answer. `thresholds` replaces `accept` for the tiers it
 * names, and the two guard probabilities when they are set. Anything left out stays on `policy`.
 * The packaged policy is Jev's starting point. It is not a calibration for nimble or tev1.
 * @param {Policy} policy
 * @param {ChannelThresholds | undefined} thresholds
 * @returns {Policy}
 */
export function policyFor(policy, thresholds) {
  if (!thresholds) return policy;
  return {
    ...policy,
    accept: thresholds.accept ? { ...policy.accept, ...thresholds.accept } : policy.accept,
    sensitiveOverride: thresholds.sensitiveOverride ?? policy.sensitiveOverride,
    claimGuard: thresholds.claimGuard ?? policy.claimGuard,
  };
}

/**
 * Sums option probabilities into tier probabilities.
 * @param {Record<string, number>} probabilities by option name
 * @param {Record<string, JevOption>} options
 * @param {string[]} tiers
 * @returns {Record<string, number>} by tier, every tier included
 */
export function tierProbabilities(probabilities, options, tiers) {
  const out = Object.fromEntries(tiers.map((t) => [t, 0]));
  for (const [option, p] of Object.entries(probabilities)) if (options[option]) out[options[option].tier] += p;
  for (const t of tiers) out[t] = Math.round(out[t] * 100) / 100; // Jev reports two decimals
  return out;
}

/**
 * Turns Jev's answer into a tier.
 * - A cheap tier needs a high probability (policy.accept); when Jev is unsure, take the more capable
 *   of its top two tiers: in LiteLLM's benchmark every miss was one tier too cheap. That step goes no
 *   higher than policy.escalationCeiling, so a tier above it takes Jev's top pick.
 * - A request that would alter production, credentials or billing gets the top tier.
 * - Text claiming the routing is already decided can't pull a request below the reference tier.
 * - In an ongoing session the tier only goes up ("ratchet"): a downgrade throws away the prompt cache.
 * @param {object} input
 * @param {PolicyInput} input.answer
 * @param {string[]} input.tiers cheapest first
 * @param {Record<string, JevOption>} input.options
 * @param {Pick<Policy, 'accept' | 'escalationCeiling' | 'sensitiveOverride' | 'claimGuard'>} input.policy
 * @param {string} input.reference the tier a routing claim can't pull the request below
 * @param {string} [input.current] the session's tier, for a ratchet
 * @returns {PolicyDecision}
 */
export function applyPolicy({ answer, tiers, options, policy, reference, current }) {
  /** @param {string} t */
  const rank = (t) => tiers.indexOf(t);
  const byTier = tierProbabilities(answer.probabilities, options, tiers);
  const ranked = [...tiers].sort((a, b) => byTier[b] - byTier[a] || rank(b) - rank(a));
  const [top, second] = ranked;
  const ceiling = policy.escalationCeiling === undefined ? tiers.length - 1 : rank(policy.escalationCeiling);
  const unsure = !(byTier[top] >= policy.accept[top]) && rank(second) > rank(top) && byTier[second] > 0;
  let tier = unsure ? tiers[Math.max(rank(top), Math.min(rank(second), ceiling))] : top;
  let reason = tier === top ? 'jev' : 'jev-escalated';
  if ((answer.sensitive ?? 0) >= policy.sensitiveOverride) {
    tier = tiers[tiers.length - 1];
    reason = 'risk-override';
  }
  if ((answer.claim ?? 0) >= policy.claimGuard && rank(tier) < rank(reference)) {
    tier = reference;
    reason = 'claim-guard';
  }
  if (current && rank(tier) <= rank(current)) return { tier: current, reason: 'jev-keep', byTier };
  if (current) return { tier, reason: `upgrade:${reason}`, byTier };
  return { tier, reason, byTier };
}
