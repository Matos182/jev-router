// Integration tests: the whole router against a mock Jev and mock upstreams on local ports. No network.
// Assertions count calls per test (call deltas), so a leftover call from an earlier test can't pass one.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { createRouter } from '../src/router.mjs';
import {
  anthropicSseWithUsage,
  claudeCodeBody,
  claudeCodeHeaders,
  claudeCodeToolTurn,
  close,
  codexBody,
  codexHeaders,
  jevOptionsAnswer,
  json,
  listen,
  mockServer,
  responsesSse,
  sha256,
  sleep,
} from './helpers.mjs';

/** @import { Server } from 'node:http' */
/** @import { Config, Env, Health, LogEntry } from '../src/types.js' */
/** @import { Mock, MockCall, MockHandler } from './helpers.mjs' */

/**
 * What a mock Jev channel does next. Unset fields keep jevOptionsAnswer's defaults.
 * @typedef {object} JevPlan
 * @property {string} [option]
 * @property {number} [probability]
 * @property {number} [sensitive]
 * @property {number} [claim]
 * @property {number} [delayMs] answer after this long
 * @property {boolean} [html403] answer like the edge firewall
 * @property {number} [status] answer with this error status
 * @property {JevPlan[]} [queue] per-call plans, used up before the plan itself applies
 */

/** @param {...string} parts */
const fake = (...parts) => parts.join('');
const AWS_KEY = fake('AKIA', 'QWERTYUIOPASDFGH');
const KEYS = {
  TYPESAFE_API_KEY: 'test-typesafe-key-DO-NOT-LOG',
  OPENROUTER_API_KEY: 'test-openrouter-key-DO-NOT-LOG',
  ANTHROPIC_API_KEY: 'test-anthropic-key-DO-NOT-LOG',
  OLLAMA_API_KEY: 'test-ollama-key-DO-NOT-LOG',
  OPENAI_API_KEY: 'test-openai-key-DO-NOT-LOG',
};

/** @type {Mock} */
let jevA;
/** @type {Mock} */
let jevB;
/** @type {Mock} */
let anthropic;
/** @type {Mock} */
let ollama;
/** @type {Mock} */
let openai;
/** @type {{ a: JevPlan, b: JevPlan }} */
const plans = { a: {}, b: {} };
/** @type {Server[]} */
const routers = [];
/** @type {LogEntry[]} */
const allLogs = [];

// A scriptable System One server: `plan.queue` holds per-call overrides, then `plan` applies.
/** @param {JevPlan} plan */
function jevMock(plan) {
  return mockServer(async (_call, res) => {
    const step = plan.queue?.shift() ?? plan;
    if (step.delayMs) await sleep(step.delayMs);
    if (step.html403) {
      res.writeHead(403, { 'content-type': 'text/html' });
      return res.end('<html><body>Attention Required! | Cloudflare</body></html>');
    }
    if (step.status) return json(res, step.status, { detail: { error_type: 'api_error', message: `mock ${step.status}` } });
    json(res, 200, jevOptionsAnswer(step), { 'x-typesafe-request-id': 'req_mock_jev' });
  });
}

/**
 * What api.anthropic.com refuses, as measured on 2026-09-24: more output tokens than the model
 * allows (64000 for Haiku 4.5, 128000 for the Claude 5 family), and for Haiku 4.5, system messages
 * inside `messages`, the 1M-context beta, and tool changes outside a system message.
 * @param {MockCall} call
 * @returns {string | undefined} the error message, or undefined when the API would accept the request
 */
function apiRefusal(call) {
  const model = String(call.body?.model ?? '');
  const haiku = /haiku-4-5/.test(model);
  const messageList = Array.isArray(call.body?.messages) ? call.body.messages : [];
  /** @param {unknown} m */
  const isSystem = (m) =>
    Boolean(m) && typeof m === 'object' && !Array.isArray(m) && /** @type {{ role?: unknown }} */ (m).role === 'system';
  if (haiku && messageList.some(isSystem)) return "role 'system' is not supported on this model";
  if (haiku && String(call.headers['anthropic-beta'] ?? '').includes('context-1m-2025-08-07'))
    return 'The long context beta is not yet available for this subscription.';
  if (/"type":"tool_(addition|removal)"/.test(JSON.stringify(messageList.filter((m) => !isSystem(m)))))
    return "'tool_addition'/'tool_removal' blocks are only permitted within `role: \"system\"` messages";
  const asked = Number(call.body?.max_tokens ?? 0);
  const limit = haiku ? 64000 : 128000;
  if (asked > limit) return `max_tokens: ${asked} > ${limit}, which is the maximum allowed number of output tokens for ${model}`;
  return undefined;
}

before(async () => {
  jevA = await jevMock(plans.a);
  jevB = await jevMock(plans.b);
  /** @type {MockHandler} */
  const messages = async (call, res) => {
    if (call.url.startsWith('/v1/messages/count_tokens')) return json(res, 200, { input_tokens: 42 });
    const refusal = apiRefusal(call);
    if (refusal) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: refusal } });
    if (!call.body.stream)
      return json(res, 200, {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: call.body.model,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    const gap = Number(call.headers['x-test-chunk-gap-ms'] ?? 0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock_sse', 'retry-after': '7' });
    const bytes = anthropicSseWithUsage(call.body.model);
    for (const piece of [bytes.subarray(0, 50), bytes.subarray(50, 300), bytes.subarray(300)]) {
      res.write(piece);
      if (gap) await sleep(gap);
    }
    res.end();
  };
  /** @type {MockHandler} */
  const responses = async (call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(responsesSse(call.body.model));
  };
  anthropic = await mockServer(messages);
  ollama = await mockServer((call, res) => (call.url.startsWith('/v1/messages') ? messages(call, res) : responses(call, res)));
  openai = await mockServer(responses);
});

after(async () => {
  await Promise.all([...routers.map(close), jevA.close(), jevB.close(), anthropic.close(), ollama.close(), openai.close()]);
});

// Left as the any that JSON.parse returns: the tests rewrite it in ways no config type allows.
/** @param {string} name a packaged config's file name, without `.json` */
const packagedConfig = (name) => JSON.parse(readFileSync(new URL(`../config/${name}.json`, import.meta.url), 'utf8'));
const shipped = packagedConfig('default');

/**
 * A packaged config, the default one unless `base` is another, pointed at the mocks, with `patch`
 * on top; `patch.policy` merges into the policy.
 * @param {Record<string, unknown> & { policy?: Record<string, unknown> }} [patch]
 * @param {any} [base]
 * @returns {Config}
 */
function testConfig(patch = {}, base = shipped) {
  const cfg = structuredClone(base);
  /** @type {Record<string, string>} */
  const hosts = { 'https://api.anthropic.com': anthropic.url, 'https://ollama.com': ollama.url, 'https://api.openai.com': openai.url };
  for (const targets of Object.values(cfg.surfaces)) for (const target of Object.values(targets)) target.url = hosts[target.url];
  cfg.jev.channels = [
    { name: 'typesafe', baseUrl: jevA.url, model: 'jev-1.13.0', keyEnv: 'TYPESAFE_API_KEY', timeoutMs: 400 },
    { name: 'openrouter', baseUrl: jevB.url, model: 'typesafe/jev-1.13', keyEnv: 'OPENROUTER_API_KEY', timeoutMs: 400 },
  ];
  cfg.jev.deadlineMs = 1500;
  return validateConfig({ ...cfg, stateFile: null, ...patch, policy: { ...cfg.policy, ...patch.policy } });
}

/** @param {{ cfg?: Config, env?: Env }} [options] */
async function startRouter({ cfg = testConfig(), env = {} } = {}) {
  /** @type {LogEntry[]} */
  const logs = [];
  const server = createRouter(cfg, {
    env: { ...KEYS, ...env },
    log: (e) => {
      logs.push(e);
      allLogs.push(e);
    },
  });
  routers.push(server);
  const url = await listen(server);
  return { url, server, logs, routes: () => logs.filter((e) => e.event === 'route'), done: () => logs.filter((e) => e.event === 'done') };
}

/**
 * @param {string} base
 * @param {string} path
 * @param {unknown} body sent as is when it's a string, as JSON otherwise
 * @param {Record<string, string>} [headers]
 */
async function post(base, path, body, headers) {
  const res = await fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString() };
}

/**
 * Runs fn and returns what it sent to each mock: { anthropic: [calls], ollama: [...], jevA: [...], ... }
 * @template T
 * @param {() => Promise<T>} fn
 */
async function delta(fn) {
  const mocks = { anthropic, ollama, openai, jevA, jevB };
  const before = Object.fromEntries(Object.entries(mocks).map(([k, m]) => [k, m.calls.length]));
  const result = await fn();
  const calls = /** @type {Record<keyof typeof mocks, MockCall[]>} */ (
    Object.fromEntries(Object.entries(mocks).map(([k, m]) => [k, m.calls.slice(before[k])]))
  );
  return { result, ...calls };
}
/**
 * @param {JevPlan} plan
 * @param {JevPlan} [value]
 */
const reset = (plan, value = {}) => {
  for (const k of /** @type {Array<keyof JevPlan>} */ (Object.keys(plan))) delete plan[k];
  Object.assign(plan, value);
};
/**
 * @param {string} session
 * @param {string} text
 * @param {Parameters<typeof claudeCodeBody>[2]} [opts]
 */
const cc = (session, text, opts) => claudeCodeBody(session, text, { stream: false, ...opts });
/**
 * @param {string} session
 * @param {Record<string, string>} [extra]
 */
const ccHeaders = (session, extra) => claudeCodeHeaders(session, { 'x-claude-code-request-class': 'main', ...extra });

test('a Claude Code prompt goes to the tier Jev picks, with only model and credentials changed', async () => {
  reset(plans.a, { option: 'deep', probability: 0.9 });
  const { url, routes } = await startRouter();
  const body = cc('s-route', 'Design the zero-downtime migration for the orders table and its rollback.');
  const d = await delta(() => post(url, '/v1/messages?beta=true', body, ccHeaders('s-route')));
  assert.equal(d.result.status, 200);
  assert.equal(d.anthropic.length, 1);
  const up = d.anthropic[0];
  assert.equal(up.url, '/v1/messages?beta=true');
  assert.deepEqual(up.body, { ...body, model: 'claude-opus-5-5' });
  assert.equal(up.headers['x-api-key'], KEYS.ANTHROPIC_API_KEY);
  assert.equal(up.headers['anthropic-beta'], ccHeaders('s-route')['anthropic-beta'], 'betas are forwarded unchanged');
  assert.equal(d.jevA.length, 1);
  const ask = d.jevA[0];
  assert.equal(ask.headers.authorization, `Bearer ${KEYS.TYPESAFE_API_KEY}`);
  assert.equal(ask.body.model, 'jev-1.13.0');
  assert.deepEqual(Object.keys(ask.body.state), ['request', 'session']);
  assert.equal(ask.body.state.request, 'Design the zero-downtime migration for the orders table and its rollback.');
  assert.equal(ask.body.state.session.harness, 'Claude Code');
  const [route] = routes();
  assert.equal(route.reason, 'jev');
  assert.ok(route.jev?.ok);
  assert.equal(route.jev.requestId, 'req_mock_jev');
  assert.deepEqual(route.jev.tiers, { fast: 0.03, balanced: 0.03, frontier: 0.93 });
  assert.equal(d.result.headers.get('x-jev-tier'), 'frontier');
});

test('Codex traffic goes to Ollama Cloud with a bearer key, minimal headers and no metadata', async () => {
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const { url } = await startRouter();
  const body = { ...codexBody('thread-1', 'Rename parse_args to parse_cli_args in cli.py'), metadata: { account: 'acct-1' } };
  const d = await delta(() => post(url, '/v1/responses', body, codexHeaders('thread-1')));
  assert.equal(d.result.status, 200);
  assert.deepEqual(d.result.bytes, responsesSse('glm-5.3-flash'));
  const up = d.ollama[0];
  assert.equal(up.body.model, 'glm-5.3-flash');
  assert.equal(up.headers.authorization, `Bearer ${KEYS.OLLAMA_API_KEY}`);
  assert.equal(up.headers['session-id'], undefined, 'client ids stay with first-party providers');
  assert.equal(up.body.metadata, undefined);
  assert.equal(d.jevA[0].body.state.session.harness, 'Codex CLI');
});

test("a ChatGPT-login target gets the client's own login on a path with stripPath removed", async () => {
  reset(plans.a, { option: 'complex', probability: 0.9 });
  const cfg = testConfig();
  const openaiTargets = cfg.surfaces.openai ?? {};
  for (const tier of ['frontier', 'max', 'trusted']) {
    const target = openaiTargets[tier];
    if (!target) continue;
    delete target.keyEnv;
    Object.assign(target, { url: `${openai.url}/backend-api/codex`, clientAuth: true, trusted: true, stripPath: '/v1' });
  }
  validateConfig(cfg); // the documented recipe loads
  const { url } = await startRouter({ cfg });
  const login = { authorization: 'Bearer chatgpt-login', 'chatgpt-account-id': 'acct-1', 'x-jev-tier': 'frontier' };
  const body = codexBody('t-chatgpt', 'Design the zero-downtime migration for the orders table.');
  const d = await delta(() => post(url, '/v1/responses?client=codex', body, codexHeaders('t-chatgpt', login)));
  assert.equal(d.result.status, 200);
  const up = d.openai[0];
  assert.equal(up.url, '/backend-api/codex/responses?client=codex');
  assert.equal(up.headers.authorization, 'Bearer chatgpt-login');
  assert.equal(up.headers['chatgpt-account-id'], 'acct-1');
  assert.equal(up.headers['x-jev-tier'], undefined);

  const cheap = await delta(() => post(url, '/v1/responses', body, codexHeaders('t-chatgpt-fast', { ...login, 'x-jev-tier': 'fast' })));
  const fast = cheap.ollama[0];
  assert.equal(fast.headers.authorization, `Bearer ${KEYS.OLLAMA_API_KEY}`, 'an untrusted target never sees the login');
  assert.equal(fast.headers['chatgpt-account-id'], undefined);
  assert.equal(fast.url, '/v1/responses');
});

test('a client login reaches only a trusted clientAuth target without a router key', async () => {
  reset(plans.a, { option: 'complex', probability: 0.9 });
  const cfg = testConfig();
  const fast = cfg.surfaces.openai?.fast;
  assert.ok(fast && !fast.trusted);
  delete fast.keyEnv;
  fast.clientAuth = true;
  const { url } = await startRouter({ cfg });
  const login = { authorization: 'Bearer chatgpt-login', 'x-api-key': 'client-key', 'chatgpt-account-id': 'acct-1' };
  const body = codexBody('t-login', 'Design the zero-downtime migration for the orders table.');
  const untrusted = await delta(() => post(url, '/v1/responses', body, codexHeaders('t-login', { ...login, 'x-jev-tier': 'fast' })));
  const up = untrusted.ollama[0];
  assert.equal(up.headers.authorization, undefined, 'clientAuth without trusted never gets the login');
  assert.equal(up.headers['chatgpt-account-id'], undefined);
  assert.equal(up.headers['x-api-key'], undefined);
  const keyed = await delta(() => post(url, '/v1/responses', body, codexHeaders('t-login-2', { ...login, 'x-jev-tier': 'frontier' })));
  assert.equal(keyed.openai[0].headers.authorization, `Bearer ${KEYS.OPENAI_API_KEY}`);
  assert.equal(keyed.openai[0].headers['chatgpt-account-id'], undefined, 'a router key leaves the account header behind');
  const unset = await startRouter({ cfg: testConfig(), env: { OPENAI_API_KEY: undefined } });
  const missing = await delta(() =>
    post(unset.url, '/v1/responses', body, codexHeaders('t-login-3', { ...login, 'x-jev-tier': 'frontier' })),
  );
  const bare = missing.openai[0].headers;
  assert.deepEqual(
    [bare.authorization, bare['x-api-key'], bare['chatgpt-account-id']],
    [undefined, undefined, undefined],
    'a trusted target without clientAuth never gets the login, even with its key unset',
  );
});

test('a session ratchets: tool loops never ask Jev, a harder new turn upgrades, an easier one keeps the tier', async () => {
  const { url, routes, logs, done } = await startRouter();
  const h = ccHeaders('s-ratchet');
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const first = cc('s-ratchet', 'What does git status -sb print?');
  const d1 = await delta(async () => {
    await post(url, '/v1/messages', first, h);
    await post(url, '/v1/messages', { ...claudeCodeToolTurn('s-ratchet', 'What does git status -sb print?'), stream: false }, h);
  });
  assert.equal(d1.jevA.length, 1, 'the tool-loop turn did not ask Jev');
  assert.deepEqual(
    d1.ollama.map((c) => c.body.model),
    ['glm-5.3-flash', 'glm-5.3-flash'],
  );

  reset(plans.a, { option: 'complex', probability: 0.9 });
  const history = [...first.messages, { role: 'assistant', content: [{ type: 'text', text: 'It prints a short status.' }] }];
  const second = cc('s-ratchet', 'Now find why the auth test fails intermittently across the session and token modules.', { history });
  const d2 = await delta(() => post(url, '/v1/messages', second, h));
  assert.equal(d2.anthropic[0].body.model, 'claude-opus-5-5');

  reset(plans.a, { option: 'mechanical', probability: 0.99 });
  const third = cc('s-ratchet', 'thanks', {
    history: [...second.messages, { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] }],
  });
  const d3 = await delta(() => post(url, '/v1/messages', third, h));
  assert.equal(d3.anthropic[0].body.model, 'claude-opus-5-5', 'no downgrade inside a session');
  assert.deepEqual(
    routes().map((r) => r.reason),
    ['jev', 'sticky', 'upgrade:jev', 'jev-keep'],
  );

  // The live view's events: `deciding` announces each Jev call, and `req` pairs a route with its done.
  assert.deepEqual(
    logs.flatMap((e) => (e.event === 'deciding' ? [`deciding:${e.turn}`] : e.event === 'route' ? [`route:${e.reason}`] : [])),
    ['deciding:1', 'route:jev', 'route:sticky', 'deciding:2', 'route:upgrade:jev', 'deciding:3', 'route:jev-keep'],
    'one deciding entry per human turn, none for the tool-loop step',
  );
  const session = routes()[0].session;
  assert.ok(logs.every((e) => e.event !== 'deciding' || e.session === session));
  for (let i = 0; i < 50 && done().length < routes().length; i += 1) await sleep(10);
  const numbers = routes().map((r) => r.req);
  assert.equal(new Set(numbers).size, numbers.length, 'every request gets its own number');
  assert.deepEqual(
    done()
      .map((d) => d.req)
      .sort(),
    [...numbers].sort(),
  );
});

test('sticky mode decides once per session', async () => {
  const { url, routes } = await startRouter({ cfg: testConfig({ policy: { mode: 'sticky' } }) });
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const first = cc('s-sticky', 'Add a test for the parser');
  await post(url, '/v1/messages', first, ccHeaders('s-sticky'));
  reset(plans.a, { option: 'deep', probability: 0.99 });
  const d = await delta(() =>
    post(
      url,
      '/v1/messages',
      cc('s-sticky', 'Now redesign everything', { history: [...first.messages, { role: 'assistant', content: 'ok' }] }),
      ccHeaders('s-sticky'),
    ),
  );
  assert.equal(d.jevA.length, 0);
  assert.equal(d.anthropic[0].body.model, 'claude-sonnet-5');
  assert.deepEqual(
    routes().map((r) => r.reason),
    ['jev', 'sticky'],
  );
});

test('when Jev fails, the session is provisional: default tier now, Jev asked again on the next turn', async () => {
  const { url, routes } = await startRouter();
  reset(plans.a, { status: 500 });
  reset(plans.b, { status: 402 });
  const first = cc('s-prov', 'Rename foo to bar');
  const d1 = await delta(() => post(url, '/v1/messages', first, ccHeaders('s-prov')));
  assert.equal(d1.result.status, 200);
  assert.equal(d1.anthropic[0].body.model, 'claude-sonnet-5', 'the default tier serves the turn');
  assert.equal(d1.jevA.length, 2, 'one retry on a 500');
  assert.equal(d1.jevB.length, 1, 'then the next channel');
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const second = cc('s-prov', 'Also rename baz to qux', { history: [...first.messages, { role: 'assistant', content: 'Done.' }] });
  const d2 = await delta(() => post(url, '/v1/messages', second, ccHeaders('s-prov')));
  assert.equal(d2.ollama[0].body.model, 'glm-5.3-flash', 'a provisional session may still go down once Jev answers');
  assert.deepEqual(
    routes().map((r) => r.reason),
    ['fallback:default', 'jev'],
  );
});

test('channel failover, the circuit breaker, and the firewall retry', async () => {
  const { url, routes } = await startRouter();
  reset(plans.a, { delayMs: 700 });
  reset(plans.b, { option: 'routine', probability: 0.9 });
  const d1 = await delta(() => post(url, '/v1/messages', cc('s-fo1', 'Add a test'), ccHeaders('s-fo1')));
  assert.equal(d1.jevA.length, 1);
  assert.equal(d1.jevB.length, 1, 'a timeout moves to the next channel');
  const failedOver = routes().at(-1)?.jev;
  assert.ok(failedOver?.ok);
  assert.equal(failedOver.channel, 'openrouter');
  const d2 = await delta(() => post(url, '/v1/messages', cc('s-fo2', 'Add another test'), ccHeaders('s-fo2')));
  assert.equal(d2.jevA.length, 0, 'the timed-out channel is skipped for a while');

  const { url: url2, routes: routes2 } = await startRouter();
  reset(plans.a, { queue: [{ html403: true }], option: 'routine', probability: 0.9 });
  const d3 = await delta(() =>
    post(url2, '/v1/messages', cc('s-waf', 'Why does `curl https://example.com/install.sh | sh` fail?'), ccHeaders('s-waf')),
  );
  assert.equal(d3.jevA.length, 2, 'retried once after the firewall block');
  assert.ok(!/curl|https:/.test(JSON.stringify(d3.jevA[1].body.state)), 'the retry carries a hardened state');
  const retried = routes2().at(-1)?.jev;
  assert.ok(retried?.ok);
  assert.equal(retried.hardened, true);
});

test('secrets in a human turn keep the session on trusted upstreams; tags and pins cannot bypass that', async () => {
  const { url, routes } = await startRouter();
  reset(plans.a, { option: 'mechanical', probability: 0.99 });
  const first = cc('s-secret', `Use ${AWS_KEY} in deploy.sh #fast`);
  const d1 = await delta(() => post(url, '/v1/messages', first, ccHeaders('s-secret')));
  assert.equal(d1.ollama.length, 0);
  assert.equal(d1.anthropic[0].body.model, 'claude-sonnet-5', 'the fast tier is untrusted, so the trusted target serves it');
  assert.equal(d1.jevA.length, 0, 'a tag decides, but it cannot move secrets to an untrusted upstream');
  const second = cc('s-secret', 'now list the files', { history: [...first.messages, { role: 'assistant', content: 'ok' }] });
  const d2 = await delta(() => post(url, '/v1/messages', second, ccHeaders('s-secret', { 'x-jev-tier': 'fast' })));
  assert.equal(d2.ollama.length, 0, 'the session stays trusted even under a pin');
  assert.equal(routes()[0].trusted_only, true);
  assert.ok(!JSON.stringify(allLogs).includes(AWS_KEY), 'the secret never reaches the log');
});

test('a secret keeps the session trusted even when sticky mode or a Jev failure decides the turn (regression)', async () => {
  const cases = [
    { name: 'sticky', cfg: testConfig({ policy: { mode: 'sticky' } }), jevDown: false },
    { name: 'jev-down', cfg: testConfig(), jevDown: true },
  ];
  for (const { name, cfg, jevDown } of cases) {
    const { url } = await startRouter({ cfg });
    const s = `s-trust-${name}`;
    reset(plans.a, { option: 'mechanical', probability: 0.99 });
    const first = cc(s, 'List the files');
    const d1 = await delta(() => post(url, '/v1/messages', first, ccHeaders(s)));
    assert.equal(d1.ollama.length, 1, `${name}: turn 1 goes to the fast tier`);
    if (jevDown) {
      reset(plans.a, { status: 500 });
      reset(plans.b, { status: 500 });
    }
    const second = cc(s, `Deploy it with ${AWS_KEY}`, { history: [...first.messages, { role: 'assistant', content: 'ok' }] });
    const d2 = await delta(() => post(url, '/v1/messages', second, ccHeaders(s)));
    assert.equal(d2.ollama.length, 0, `${name}: the turn with the secret stays trusted`);
    const third = cc(s, 'Now list the files again', { history: [...second.messages, { role: 'assistant', content: 'done' }] });
    const d3 = await delta(() => post(url, '/v1/messages', third, ccHeaders(s)));
    assert.equal(d3.ollama.length, 0, `${name}: a clean turn after the secret stays trusted`);
    assert.equal(d3.anthropic[0].body.model, 'claude-sonnet-5');
  }
  reset(plans.a);
  reset(plans.b);
});

test('secrets in tool output are redacted before an untrusted upstream sees them', async () => {
  const { url } = await startRouter();
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const h = ccHeaders('s-redact');
  await post(url, '/v1/messages', cc('s-redact', 'Show me the env file'), h);
  const loop = cc('s-redact', 'Show me the env file');
  loop.messages.push(
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'read it', signature: 'sig-ollama' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '.env' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `AWS_ACCESS_KEY_ID=${AWS_KEY}` }] },
  );
  const d = await delta(() => post(url, '/v1/messages', loop, h));
  const sent = JSON.stringify(d.ollama[0].body);
  assert.ok(!sent.includes(AWS_KEY));
  assert.ok(sent.includes('[REDACTED aws-access-key]'));
  assert.equal(d.ollama[0].body.messages[1].content[0].signature, 'sig-ollama', 'signed thinking is untouched');
  assert.equal(d.result.headers.get('x-jev-redacted'), '1');
});

test('pins really route to the pinned tier (regression: a fast pin used to land on the trusted tier)', async () => {
  const { url, logs } = await startRouter();
  const d1 = await delta(() => post(url, '/v1/messages', cc('s-pin', 'hi'), ccHeaders('s-pin', { 'x-jev-tier': 'fast' })));
  assert.equal(d1.ollama.length, 1);
  assert.equal(d1.ollama[0].body.model, 'glm-5.3-flash');
  assert.equal(d1.jevA.length, 0);
  assert.equal(d1.ollama[0].headers['x-jev-tier'], undefined, 'the control header is not forwarded');
  const { url: url2 } = await startRouter({ env: { JEV_ROUTER_TIER: 'frontier' } });
  const d2 = await delta(() => post(url2, '/v1/messages', cc('s-pin-env', 'hi'), ccHeaders('s-pin-env')));
  assert.equal(d2.anthropic[0].body.model, 'claude-opus-5-5');
  reset(plans.a, { option: 'routine', probability: 0.9 });
  await post(url, '/v1/messages', cc('s-pin-bad', 'hi'), ccHeaders('s-pin-bad', { 'x-jev-tier': 'Frontier' }));
  assert.ok(logs.some((e) => e.event === 'warning' && /unknown tier pin "Frontier"/.test(e.message)));
});

test('background calls, subagents and compaction never ask Jev or move the session', async () => {
  reset(plans.a, { option: 'deep', probability: 0.95 });
  const { url, routes } = await startRouter();
  const d = await delta(async () => {
    await post(
      url,
      '/v1/messages',
      cc('s-kinds', 'Write a 5-word title', { model: 'claude-haiku-4-5-20251001' }),
      claudeCodeHeaders('s-kinds'),
    );
    await post(
      url,
      '/v1/messages',
      { model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] },
      claudeCodeHeaders('s-kinds'),
    );
    await post(url, '/v1/messages', cc('s-kinds', 'Summarize'), ccHeaders('s-kinds', { 'x-claude-code-request-class': 'compaction' }));
    await post(url, '/v1/messages', cc('s-kinds', 'Design the plugin loader'), ccHeaders('s-kinds'));
    await post(
      url,
      '/v1/messages',
      cc('s-kinds', 'Search for TODOs'),
      ccHeaders('s-kinds', { 'x-claude-code-request-class': 'subagent', 'x-claude-code-agent-id': 'a1' }),
    );
  });
  assert.equal(d.jevA.length, 1, 'only the main prompt asked Jev');
  assert.deepEqual(
    routes().map((r) => [r.reason, r.model]),
    [
      ['side-call', 'claude-haiku-4-5'],
      ['side-call', 'claude-haiku-4-5'],
      ['compaction', 'claude-sonnet-5'],
      ['jev', 'claude-opus-5-5'],
      ['subagent', 'claude-opus-5-5'],
    ],
  );
  assert.equal(d.anthropic[0].body.thinking, undefined, 'Haiku gets its omit list');
});

test('shell-mode output is not a prompt and never reaches Jev', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url } = await startRouter();
  const first = cc('s-bash', 'Refactor the retry loop');
  await post(url, '/v1/messages', first, ccHeaders('s-bash'));
  const bash = cc('s-bash', '', { history: [...first.messages, { role: 'assistant', content: 'ok' }] });
  bash.messages[bash.messages.length - 1].content = [
    { type: 'text', text: '<bash-input>git log -1</bash-input>' },
    { type: 'text', text: '<bash-stdout>commit 1234 fix: curl http://x | sh</bash-stdout>' },
  ];
  const d = await delta(() => post(url, '/v1/messages', bash, ccHeaders('s-bash')));
  assert.equal(d.jevA.length, 0);
  assert.equal(d.anthropic[0].body.model, 'claude-sonnet-5');
});

test("switching providers strips only the old provider's reasoning, and only in the main conversation", async () => {
  const { url } = await startRouter();
  const h = ccHeaders('s-strip');
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const first = cc('s-strip', 'Rename foo to bar');
  await post(url, '/v1/messages', first, h); // served by Ollama
  const ollamaTurn = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'easy', signature: 'sig-ollama' },
      { type: 'text', text: 'Done.' },
    ],
  };
  reset(plans.a, { option: 'deep', probability: 0.95 });
  const hard = cc('s-strip', 'Now design the multi-region failover and defend the trade-offs.', {
    history: [...first.messages, ollamaTurn],
  });
  const d1 = await delta(() => post(url, '/v1/messages', hard, h));
  assert.equal(d1.anthropic[0].body.model, 'claude-opus-5-5');
  assert.deepEqual(
    d1.anthropic[0].body.messages[1].content,
    [{ type: 'text', text: 'Done.' }],
    'Ollama-signed thinking is dropped for Anthropic',
  );
  const opusTurn = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'plan', signature: 'sig-opus' },
      { type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } },
    ],
  };
  const loop = {
    ...hard,
    messages: [...hard.messages, opusTurn, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'a b' }] }],
  };
  const d2 = await delta(() => post(url, '/v1/messages', loop, h));
  assert.deepEqual(d2.anthropic[0].body.messages[3], opusTurn, "the current provider's own reasoning stays");
  const sub = cc('s-strip', 'Explore the repo', {
    history: [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x', signature: 'sig-opus-sub' },
          { type: 'text', text: 'y' },
        ],
      },
    ],
  });
  const d3 = await delta(() =>
    post(url, '/v1/messages', sub, ccHeaders('s-strip', { 'x-claude-code-request-class': 'subagent', 'x-claude-code-agent-id': 'a2' })),
  );
  assert.equal(d3.anthropic[0].body.messages[1].content[0].signature, 'sig-opus-sub', 'subagent conversations are not stripped');
});

test('count_tokens follows the session tier and stays local for Ollama', async () => {
  const { url } = await startRouter();
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  await post(url, '/v1/messages', cc('s-count', 'Explain this regex'), ccHeaders('s-count'));
  const { model, max_tokens, stream, metadata, ...countBody } = cc('s-count', 'Explain this regex');
  const d = await delta(() =>
    post(url, '/v1/messages/count_tokens?beta=true', { model: 'claude-sonnet-5', ...countBody }, claudeCodeHeaders('s-count')),
  );
  assert.equal(d.result.status, 404);
  assert.equal(d.ollama.length + d.anthropic.length + d.jevA.length, 0, 'no provider counted an Ollama-bound prompt');
});

test('responses stream back byte for byte, unbuffered, with usage and cost in the log', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url, done } = await startRouter();
  const started = performance.now();
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: ccHeaders('s-sse', { 'x-test-chunk-gap-ms': '150' }),
    body: JSON.stringify(claudeCodeBody('s-sse', 'Add a test for the parser')),
  });
  assert.ok(res.body);
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {number | undefined} */
  let first;
  for await (const chunk of res.body) {
    first ??= performance.now() - started;
    chunks.push(chunk);
  }
  const got = Buffer.concat(chunks);
  assert.equal(Buffer.compare(got, anthropicSseWithUsage('claude-sonnet-5')), 0);
  assert.ok(first !== undefined && first < performance.now() - started - 200, 'the first bytes arrived before the stream ended');
  assert.equal(res.headers.get('retry-after'), '7', 'upstream headers pass through');
  const entry = done().at(-1);
  assert.ok(entry);
  assert.equal(entry.sha256, sha256(got));
  assert.deepEqual(entry.usage, { input: 12, cacheRead: 1000, cacheWrite: 0, output: 9 });
  assert.equal(entry.cost_usd, 0.000314);
  assert.equal(entry.baseline_usd, 0.000428, 'the same usage on the baseline model (Opus 5.5)');
});

test('a slow client gets a large stream in full without piling up listeners (regression: each wait for drain left two behind)', async () => {
  const chunk = Buffer.alloc(64 * 1024, 'a');
  const chunks = 128; // 8 MiB: more than loopback buffers take, so the router waits for the client again and again
  const big = await mockServer(async (_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < chunks; i += 1) if (!res.write(chunk)) await once(res, 'drain');
    res.end();
  });
  const cfg = testConfig();
  const targets = cfg.surfaces.anthropic;
  assert.ok(targets);
  targets.balanced.url = big.url;
  const { url, server } = await startRouter({ cfg });
  /** @type {import('node:http').ServerResponse | undefined} */
  let relaying;
  server.on('request', (_req, res) => {
    relaying = res;
  });
  let most = 0;
  try {
    const received = await new Promise((resolve, reject) => {
      const req = http.request(
        `${url}/v1/messages`,
        { method: 'POST', headers: ccHeaders('s-slow', { 'x-jev-tier': 'balanced' }) },
        (res) => {
          let bytes = 0;
          res.on('data', (piece) => {
            bytes += piece.length;
            most = Math.max(most, relaying?.listenerCount('close') ?? 0);
            res.pause();
            setTimeout(() => res.resume(), 1);
          });
          res.on('end', () => resolve(bytes));
          res.on('error', reject);
        },
      );
      req.end(JSON.stringify(cc('s-slow', 'Stream a lot')));
    });
    assert.equal(received, chunks * chunk.length, 'every byte arrived');
    assert.ok(most <= 3, `the relayed response had ${most} close listeners at once`);
  } finally {
    await big.close();
  }
});

test('browser-shaped requests, wrong content types, oversized bodies and missing tokens are refused', async () => {
  const { url } = await startRouter();
  const port = new URL(url).port;
  /** @type {(headers: Record<string, string>, body?: string) => Promise<number | undefined>} */
  const raw = (headers, body = '{}') =>
    new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.end(body);
    });
  const d = await delta(async () => [
    await raw({ host: `attacker.example:${port}`, 'content-type': 'application/json' }),
    await raw({ host: `127.0.0.1:${port}`, origin: 'https://attacker.example', 'content-type': 'text/plain' }),
    await raw({ host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }),
  ]);
  assert.deepEqual(d.result, [403, 403, 415]);
  assert.equal(d.anthropic.length + d.ollama.length, 0);
  const small = await startRouter({ cfg: testConfig({ maxBodyBytes: 1000 }) });
  assert.equal((await post(small.url, '/v1/messages', cc('s-big', 'x'.repeat(5000)), ccHeaders('s-big'))).status, 413);
  const locked = await startRouter({ env: { JEV_ROUTER_TOKEN: 'local-secret' } });
  assert.equal((await post(locked.url, '/v1/messages', cc('s-tok', 'hi'), ccHeaders('s-tok'))).status, 401);
  reset(plans.a, { option: 'routine', probability: 0.9 });
  assert.equal(
    (await post(locked.url, '/v1/messages', cc('s-tok', 'hi'), ccHeaders('s-tok', { 'x-jev-router-token': 'local-secret' }))).status,
    200,
  );
});

test("malformed requests get an error in the client's shape and the router keeps serving", async () => {
  const { url } = await startRouter();
  const plain = { 'content-type': 'application/json' };
  for (const bad of ['null', '[]', '42']) assert.equal((await post(url, '/v1/messages', bad, plain)).status, 400, bad);
  assert.equal((await post(url, '/v1/messages', { messages: 'oops' }, plain)).status, 500);
  const codex = await post(url, '/v1/responses', 'null', plain);
  assert.deepEqual(JSON.parse(codex.text), {
    error: { message: 'Request body must be a JSON object', type: 'invalid_request_error', param: null, code: null },
  });
  assert.equal(codex.headers.get('x-should-retry'), 'false');
  reset(plans.a, { option: 'routine', probability: 0.9 });
  assert.equal((await post(url, '/v1/messages', cc('s-after', 'hi'), ccHeaders('s-after'))).status, 200);
});

test('a surface the config leaves out is a 404 that costs no Jev call (regression: Jev was asked, then a 500)', async () => {
  const cfg = testConfig();
  delete cfg.surfaces.openai;
  const { url } = await startRouter({ cfg });
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const d = await delta(() => post(url, '/v1/responses', codexBody('t-none', 'Rename foo to bar'), codexHeaders('t-none')));
  assert.equal(d.result.status, 404);
  assert.equal(JSON.parse(d.result.text).error.type, 'not_found_error', 'in the OpenAI error shape');
  assert.equal(d.jevA.length + d.jevB.length + d.ollama.length + d.openai.length, 0);
});

test('decisions survive a restart through the state file', async () => {
  const stateFile = `${mkdtempSync(`${tmpdir()}/jev-router-`)}/sessions.jsonl`;
  reset(plans.a, { option: 'deep', probability: 0.95 });
  const one = await startRouter({ cfg: testConfig({ stateFile }) });
  const first = cc('s-persist', 'Design the sharding scheme');
  await post(one.url, '/v1/messages', first, ccHeaders('s-persist'));
  await close(one.server);
  const two = await startRouter({ cfg: testConfig({ stateFile }) });
  const d = await delta(() =>
    post(
      two.url,
      '/v1/messages',
      { ...claudeCodeToolTurn('s-persist', 'Design the sharding scheme'), stream: false },
      ccHeaders('s-persist'),
    ),
  );
  assert.equal(d.jevA.length, 0);
  assert.equal(d.anthropic[0].body.model, 'claude-opus-5-5', 'the tool loop continues on the same model after a restart');
  assert.ok(!readFileSync(stateFile, 'utf8').includes('sharding'), 'the state file holds no prompt text');
});

test('an unusable state file is a warning, and sessions stay in memory (regression: a ReferenceError at startup)', async () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-router-`);
  writeFileSync(`${dir}/not-a-dir`, '');
  const { url, logs } = await startRouter({ cfg: testConfig({ stateFile: `${dir}/not-a-dir/sessions.jsonl` }) });
  assert.ok(logs.some((e) => e.event === 'warning' && e.message.startsWith('session file: ')));
  reset(plans.a, { option: 'routine', probability: 0.9 });
  assert.equal((await post(url, '/v1/messages', cc('s-nofile', 'hi'), ccHeaders('s-nofile'))).status, 200);
});

test('/model in Claude Code pins the matching tier; /healthz reports the router state', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url } = await startRouter();
  const first = cc('s-model', 'Add a test', { model: 'claude-opus-5-5' });
  await post(url, '/v1/messages', first, ccHeaders('s-model'));
  const d = await delta(() =>
    post(
      url,
      '/v1/messages',
      cc('s-model', 'keep going', { model: 'claude-haiku-4-5', history: [...first.messages, { role: 'assistant', content: 'ok' }] }),
      ccHeaders('s-model'),
    ),
  );
  assert.equal(d.result.headers.get('x-jev-reason'), 'client-model:haiku');
  assert.equal(d.ollama[0].body.model, 'glm-5.3-flash');
  const health = /** @type {Health} */ (await (await fetch(`${url}/healthz`)).json());
  assert.equal(health.ok, true);
  assert.equal(health.jev.configured, true);
  assert.ok(health.sessions >= 1);
});

test('the Fable config sends deep work, /model fable and #max to Fable 5.1; after a switch back, a session keeps a strong model', async () => {
  const { url, server, routes } = await startRouter({ cfg: testConfig({}, packagedConfig('anthropic-fable')) });
  const h = ccHeaders('s-fable');
  const text = 'Choose between these two architectures for the session store and defend the choice.';
  reset(plans.a, { option: 'deep', probability: 0.81 });
  const d1 = await delta(async () => {
    await post(url, '/v1/messages', cc('s-fable', text), h);
    await post(url, '/v1/messages', { ...claudeCodeToolTurn('s-fable', text), stream: false }, h);
  });
  assert.deepEqual(
    d1.anthropic.map((c) => c.body.model),
    ['claude-fable-5-1', 'claude-fable-5-1'],
  );
  assert.equal(d1.jevA.length, 1, 'the tool step keeps the tier of its turn');
  assert.deepEqual(
    routes().map((r) => `${r.tier}:${r.reason}`),
    ['max:jev', 'max:sticky'],
  );

  reset(plans.a, { option: 'complex', probability: 0.9 });
  const first = cc('s-opus', 'Find why the auth test fails intermittently.', { model: 'claude-opus-5-5' });
  assert.equal((await delta(() => post(url, '/v1/messages', first, ccHeaders('s-opus')))).anthropic[0].body.model, 'claude-opus-5-5');
  const history = [...first.messages, { role: 'assistant', content: 'ok' }];
  const pinned = await delta(() =>
    post(url, '/v1/messages', cc('s-opus', 'keep going', { model: 'claude-fable-5-1', history }), ccHeaders('s-opus')),
  );
  assert.equal(pinned.result.headers.get('x-jev-reason'), 'client-model:fable');
  assert.equal(pinned.anthropic[0].body.model, 'claude-fable-5-1');

  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const tagged = await delta(() => post(url, '/v1/messages', cc('s-tag', 'Review the migration plan #max'), ccHeaders('s-tag')));
  assert.equal(tagged.result.headers.get('x-jev-reason'), 'tag');
  assert.equal(tagged.anthropic[0].body.model, 'claude-fable-5-1');
  assert.equal(tagged.jevA.length, 0);

  // The Claude-only config has no max tier. A session that was on it goes on with the top tier the
  // config has, Opus 5.5: falling back to the cheapest tier would put its tool steps on Haiku 4.5.
  server.reload(testConfig({}, packagedConfig('anthropic-only')));
  const toolTurn = { ...claudeCodeToolTurn('s-fable', text), stream: false };
  const after = await delta(() => post(url, '/v1/messages', toolTurn, h));
  assert.equal(after.anthropic[0].body.model, 'claude-opus-5-5');
  assert.equal(after.result.headers.get('x-jev-tier'), 'frontier');
  // Its model changed, so its cache is cold: the next message is decided afresh, and may go down.
  reset(plans.a, { option: 'mechanical', probability: 0.95 });
  const next = cc('s-fable', 'Fix the typo in the README.', { history: [...toolTurn.messages, { role: 'assistant', content: 'Done.' }] });
  const fresh = await delta(() => post(url, '/v1/messages', next, h));
  assert.equal(fresh.result.headers.get('x-jev-reason'), 'jev');
  assert.equal(fresh.anthropic[0].body.model, 'claude-haiku-4-5');
});

test('a client that leaves during the Jev call costs no upstream request', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9, delayMs: 300 });
  const { url, done } = await startRouter();
  const controller = new AbortController();
  const d = await delta(async () => {
    const pending = fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: ccHeaders('s-abort'),
      body: JSON.stringify(cc('s-abort', 'Add a test')),
      signal: controller.signal,
    }).catch(() => null);
    await sleep(100);
    controller.abort();
    await pending;
    await sleep(400);
  });
  assert.equal(d.anthropic.length + d.ollama.length, 0);
  assert.equal(done().at(-1)?.client_aborted, true);
});

test("two requests of one turn share its Jev call, and one that leaves doesn't cancel it for the other (regression)", async () => {
  reset(plans.a, { option: 'deep', probability: 0.9, delayMs: 300 });
  const { url, routes } = await startRouter();
  const body = cc('s-share', 'Design the cache');
  const controller = new AbortController();
  const d = await delta(async () => {
    const leaving = fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: ccHeaders('s-share'),
      body: JSON.stringify(body),
      signal: controller.signal,
    }).catch(() => null);
    await sleep(50);
    const staying = post(url, '/v1/messages', body, ccHeaders('s-share'));
    await sleep(50);
    controller.abort();
    await leaving;
    return staying;
  });
  assert.equal(d.jevA.length, 1, 'one Jev call for the turn');
  assert.equal(d.result.status, 200);
  assert.equal(d.result.headers.get('x-jev-reason'), 'jev', "the request that stayed got Jev's answer");
  assert.deepEqual(
    d.anthropic.map((call) => call.body.model),
    ['claude-opus-5-5'],
    'and only it went upstream',
  );
  assert.deepEqual(
    routes().map((r) => r.reason),
    ['jev', 'jev'],
  );
});

test('server.active counts requests in flight, so a shutdown can wait for them (regression: it stayed 0)', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url, server } = await startRouter();
  assert.equal(server.active, 0);
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: ccHeaders('s-active', { 'x-test-chunk-gap-ms': '50' }),
    body: JSON.stringify(claudeCodeBody('s-active', 'Add a test for the parser')),
  });
  assert.equal(server.active, 1, 'the response is still streaming');
  await res.arrayBuffer();
  assert.equal(server.active, 0);
});

test("a target's omit list removes nested fields and keeps their siblings", async () => {
  const { url } = await startRouter();
  const body = {
    ...cc('s-omit', 'Write a 5-word title', { model: 'claude-haiku-4-5' }),
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: 'text' },
    context_management: { edits: [] },
  };
  const d = await delta(() => post(url, '/v1/messages', body, claudeCodeHeaders('s-omit')));
  const sent = d.anthropic[0].body;
  assert.equal(sent.model, 'claude-haiku-4-5');
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.context_management, undefined);
  assert.deepEqual(sent.output_config, { format: 'text' }, 'only output_config.effort goes');
});

test("max_tokens is capped at the target model's output limit, and an upstream error's message is logged", async () => {
  // Claude Code sizes max_tokens for the model it thinks it talks to: 128000 for Opus 5.5.
  const { url, done } = await startRouter();
  const haiku = await delta(() =>
    post(
      url,
      '/v1/messages',
      cc('s-cap', 'Write a 5-word title', { model: 'claude-haiku-4-5', maxTokens: 128000 }),
      claudeCodeHeaders('s-cap'),
    ),
  );
  assert.equal(haiku.result.status, 200);
  assert.equal(haiku.anthropic[0].body.max_tokens, 64000, 'Haiku 4.5 takes at most 64000');
  assert.equal(haiku.result.headers.get('x-jev-max-tokens'), '64000');
  const opus = await delta(() =>
    post(url, '/v1/messages', cc('s-cap-opus', 'Refactor the parser', { maxTokens: 128000 }), {
      ...claudeCodeHeaders('s-cap-opus'),
      'x-jev-tier': 'frontier',
    }),
  );
  assert.equal(opus.anthropic[0].body.max_tokens, 128000, 'Opus 5.5 takes all of it');
  assert.equal(opus.result.headers.get('x-jev-max-tokens'), null);
  for (let i = 0; i < 50 && done().length < 2; i += 1) await sleep(10);
  assert.deepEqual(
    done().map((d) => d.capped_max_tokens),
    [64000, undefined],
  );

  // A target's own limit wins, and a thinking budget stays below it.
  const cfg = testConfig();
  const targets = cfg.surfaces.anthropic;
  assert.ok(targets);
  targets.frontier.maxOutputTokens = 2048;
  targets.side.maxOutputTokens = 200000;
  const custom = await startRouter({ cfg });
  const budget = await delta(() =>
    post(
      custom.url,
      '/v1/messages',
      { ...cc('s-budget', 'Plan the migration', { maxTokens: 8000 }), thinking: { type: 'enabled', budget_tokens: 4096 } },
      {
        ...claudeCodeHeaders('s-budget'),
        'x-jev-tier': 'frontier',
      },
    ),
  );
  assert.equal(budget.anthropic[0].body.max_tokens, 2048);
  assert.deepEqual(budget.anthropic[0].body.thinking, { type: 'enabled', budget_tokens: 2047 });

  // Too generous a limit lets the upstream refuse; its message lands in the done line.
  const refused = await delta(() =>
    post(
      custom.url,
      '/v1/messages',
      cc('s-refused', 'Title', { model: 'claude-haiku-4-5', maxTokens: 128000 }),
      claudeCodeHeaders('s-refused'),
    ),
  );
  assert.equal(refused.result.status, 400);
  for (let i = 0; i < 50 && custom.done().length < 2; i += 1) await sleep(10);
  assert.match(String(custom.done().at(-1)?.error), /^max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens/);
});

test('mid-conversation system messages are folded for a model that rejects them, and kept for the Claude 5 family', async () => {
  const { url, done } = await startRouter();
  const toolTurn = claudeCodeToolTurn('s-fold', 'List the files.');
  const system = { role: 'system', content: 'Answer in one word.' };
  const body = {
    ...toolTurn,
    model: 'claude-haiku-4-5',
    stream: false,
    messages: [...toolTurn.messages, system, { role: 'system', content: [] }],
  };
  const haiku = await delta(() => post(url, '/v1/messages', body, claudeCodeHeaders('s-fold')));
  assert.equal(haiku.result.status, 200, 'Haiku 4.5 gets no system messages');
  /** @typedef {{ role: string, content: Array<{ type: string, text?: string }> }} SentMessage */
  const sent = /** @type {SentMessage[]} */ (/** @type {unknown} */ (haiku.anthropic[0].body.messages));
  assert.equal(sent.length, toolTurn.messages.length, 'the reminder joined the tool result message, the empty directive went');
  const last = sent.at(-1);
  assert.ok(last);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result', 'tool results stay first');
  assert.deepEqual(last.content.at(-1), { type: 'text', text: '<system-reminder>\nAnswer in one word.\n</system-reminder>' });

  const opus = await delta(() =>
    post(
      url,
      '/v1/messages',
      { ...cc('s-keep', 'Refactor the parser'), messages: [...cc('s-keep', 'Refactor the parser').messages, system] },
      {
        ...claudeCodeHeaders('s-keep'),
        'x-jev-tier': 'frontier',
      },
    ),
  );
  const kept = /** @type {SentMessage[]} */ (/** @type {unknown} */ (opus.anthropic[0].body.messages));
  assert.deepEqual(kept.at(-1), system, 'Opus 5.5 takes them as they are');
  for (let i = 0; i < 50 && done().length < 2; i += 1) await sleep(10);
  assert.deepEqual(
    done().map((d) => d.folded_system),
    [2, undefined],
  );
});

test("Haiku 4.5 gets no 1M-context beta, and a folded system message's tool additions join the tools", async () => {
  const { url } = await startRouter();
  const lookup = { name: 'Lookup', description: 'Look a thing up', input_schema: { type: 'object', properties: {} } };
  const deferred = {
    name: 'Deferred',
    description: 'Loaded on demand',
    input_schema: { type: 'object', properties: {} },
    defer_loading: true,
  };
  const prompt = cc('s-tools', 'Say ok.', { model: 'claude-haiku-4-5' });
  const system = {
    role: 'system',
    content: [
      { type: 'text', text: 'Two tools changed.' },
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Bash' } },
      { type: 'tool_addition', tool: { type: 'tool_definition', definition: lookup } },
      { type: 'tool_addition', tool: { type: 'tool_reference', name: 'Deferred' } },
    ],
  };
  const body = { ...prompt, tools: [.../** @type {unknown[]} */ (prompt.tools ?? []), deferred], messages: [...prompt.messages, system] };
  const headers = { ...claudeCodeHeaders('s-tools'), 'anthropic-beta': 'claude-code-20250219,context-1m-2025-08-07,oauth-2025-04-20' };
  const haiku = await delta(() => post(url, '/v1/messages', body, headers));
  assert.equal(haiku.result.status, 200);
  assert.equal(haiku.anthropic[0].headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20', 'only the 1M beta goes');
  const sent = /** @type {{ tools: Array<Record<string, unknown>>, messages: Array<{ role: string, content: unknown }> }} */ (
    /** @type {unknown} */ (haiku.anthropic[0].body)
  );
  assert.deepEqual(
    sent.tools.map((t) => [t.name, t.defer_loading]),
    [
      ['Bash', undefined],
      ['Deferred', undefined],
      ['Lookup', undefined],
    ],
    'the definition joined the tools, the deferred tool is loaded, the removed one stays',
  );
  assert.doesNotMatch(JSON.stringify(sent.messages), /tool_addition|tool_removal|"role":"system"/);
  assert.match(JSON.stringify(sent.messages.at(-1)), /<system-reminder>\\nTwo tools changed\.\\n<\/system-reminder>/);

  const opus = await delta(() =>
    post(url, '/v1/messages', { ...body, model: 'claude-opus-5-5' }, { ...headers, 'x-jev-tier': 'frontier' }),
  );
  assert.equal(
    opus.anthropic[0].headers['anthropic-beta'],
    'claude-code-20250219,context-1m-2025-08-07,oauth-2025-04-20',
    'Opus 5.5 keeps it',
  );
  assert.deepEqual(/** @type {Array<unknown>} */ (/** @type {unknown} */ (opus.anthropic[0].body.messages)).at(-1), system);
});

test('the router answers its own errors in the shape of the client API', async () => {
  const { url } = await startRouter();
  const notFound = await fetch(`${url}/v1/models`);
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { type: 'error', error: { type: 'not_found_error', message: 'No route for GET /v1/models' } });
  assert.equal(notFound.headers.get('x-should-retry'), 'false');
  const plain = { 'content-type': 'application/json' };
  const notJson = await post(url, '/v1/messages', '{"messages": [', plain);
  assert.equal(notJson.status, 400);
  assert.deepEqual(JSON.parse(notJson.text), {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'Request body is not JSON' },
  });
  const openaiNotJson = await post(url, '/v1/responses', 'nope', plain);
  assert.deepEqual(JSON.parse(openaiNotJson.text).error, {
    message: 'Request body is not JSON',
    type: 'invalid_request_error',
    param: null,
    code: null,
  });
});

test('an upstream that cannot be reached is a 502 the client may retry', async () => {
  const cfg = testConfig();
  const gone = http.createServer();
  const goneUrl = await listen(gone);
  await close(gone);
  for (const target of Object.values(cfg.surfaces.openai ?? {})) target.url = goneUrl;
  const { url, logs } = await startRouter({ cfg });
  reset(plans.a, { option: 'deep', probability: 0.9 });
  const res = await post(url, '/v1/responses', codexBody('t-gone', 'Design the retry policy'), codexHeaders('t-gone'));
  assert.equal(res.status, 502);
  const { error } = JSON.parse(res.text);
  assert.equal(error.type, 'api_error');
  assert.match(
    error.message,
    /^Upstream request to 127\.0\.0\.1:\d+ failed: connect ECONNREFUSED 127\.0\.0\.1:\d+$/,
    'the cause, not "fetch failed"',
  );
  assert.equal(res.headers.get('x-should-retry'), null, 'no x-should-retry: false on a 5xx');
  assert.equal(res.headers.get('x-jev-tier'), 'frontier', 'the decision headers are still shown');
  assert.ok(logs.some((e) => e.event === 'error' && e.session && e.error === `u${error.message.slice(1)}`));
});

test('an upstream whose TLS handshake or DNS lookup fails is a 502 that names the cause', async () => {
  const plain = http.createServer((_req, res) => res.end('not TLS'));
  const plainUrl = await listen(plain);
  const cfg = testConfig();
  for (const target of Object.values(cfg.surfaces.openai ?? {})) target.url = plainUrl.replace('http:', 'https:');
  const nowhere = 'https://api.nowhere.invalid';
  for (const target of Object.values(cfg.surfaces.anthropic ?? {})) target.url = nowhere;
  const { url, logs } = await startRouter({ cfg });
  const tls = await post(url, '/v1/responses', codexBody('t-tls', 'Design it'), codexHeaders('t-tls', { 'x-jev-tier': 'frontier' }));
  assert.equal(tls.status, 502);
  assert.match(JSON.parse(tls.text).error.message, /^Upstream request to 127\.0\.0\.1:\d+ failed: TLS error: \w/);
  await close(plain);

  // Tests have no network, so a stand-in for fetch fails the lookup the way undici does.
  const real = globalThis.fetch;
  const lookup = Object.assign(new Error('getaddrinfo ENOTFOUND api.nowhere.invalid'), { code: 'ENOTFOUND' });
  globalThis.fetch = /** @type {typeof fetch} */ (
    (input, init) =>
      String(input).startsWith(nowhere) ? Promise.reject(new TypeError('fetch failed', { cause: lookup })) : real(input, init)
  );
  try {
    const dns = await post(url, '/v1/messages', cc('s-dns', 'Add a test'), ccHeaders('s-dns', { 'x-jev-tier': 'frontier' }));
    assert.equal(dns.status, 502);
    assert.equal(
      JSON.parse(dns.text).error.message,
      'Upstream request to api.nowhere.invalid failed: getaddrinfo ENOTFOUND api.nowhere.invalid',
    );
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(
    logs
      .filter((e) => e.event === 'error')
      .map((e) => /** @type {{ error: string }} */ (e).error.replace(/:\d+/g, ':<port>').replace(/TLS error: .*/, 'TLS error: …')),
    [
      'upstream request to 127.0.0.1:<port> failed: TLS error: …',
      'upstream request to api.nowhere.invalid failed: getaddrinfo ENOTFOUND api.nowhere.invalid',
    ],
  );
});

test('a stream the upstream cuts off is cut off for the client too, and what it cost still reaches the log', async () => {
  const cutter = await mockServer((_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(anthropicSseWithUsage('claude-sonnet-5').subarray(0, 400)); // message_start, with its usage, and a little more
    setTimeout(() => res.socket?.destroy(), 30);
  });
  const cfg = testConfig();
  const targets = cfg.surfaces.anthropic;
  assert.ok(targets);
  targets.balanced.url = cutter.url;
  const { url, logs, done } = await startRouter({ cfg });
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: ccHeaders('s-cut', { 'x-jev-tier': 'balanced' }),
    body: JSON.stringify(claudeCodeBody('s-cut', 'Add a test')),
  });
  assert.equal(res.status, 200);
  await assert.rejects(res.arrayBuffer(), /terminated/, 'the client sees the break, not a response that ends cleanly');
  for (let i = 0; i < 50 && !done().some((e) => e.session && e.bytes === 400); i += 1) await sleep(10);
  const entry = done().find((e) => e.bytes === 400);
  assert.ok(entry);
  assert.equal(entry.status, 200);
  assert.match(String(entry.error), /^the stream from 127\.0\.0\.1:\d+ broke off after 400 bytes: other side closed \(UND_ERR_SOCKET\)$/);
  assert.deepEqual(entry.usage, { input: 12, cacheRead: 1000, cacheWrite: 0, output: 1 });
  assert.ok((entry.cost_usd ?? 0) > 0, 'what the broken stream cost is on the ledger');
  assert.ok(
    logs.some((e) => e.event === 'error' && e.req === entry.req && e.error === entry.error),
    'and an error entry says what happened',
  );
  await cutter.close();
  const next = await post(url, '/v1/messages', cc('s-after-cut', 'hi'), ccHeaders('s-after-cut', { 'x-jev-tier': 'frontier' }));
  assert.equal(next.status, 200, 'the router carries on');
});

test('a client that leaves before the upstream answers, or while it sends its request, is logged as gone', async () => {
  const slow = await mockServer(async (_call, res) => {
    await sleep(300);
    json(res, 200, { id: 'msg', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const cfg = testConfig();
  const targets = cfg.surfaces.anthropic;
  assert.ok(targets);
  targets.balanced.url = slow.url;
  const { url, logs, done } = await startRouter({ cfg });
  const controller = new AbortController();
  const pending = fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: ccHeaders('s-gone', { 'x-jev-tier': 'balanced' }),
    body: JSON.stringify(cc('s-gone', 'Add a test')),
    signal: controller.signal,
  }).catch(() => null);
  await sleep(100);
  controller.abort();
  await pending;
  for (let i = 0; i < 50 && done().length === 0; i += 1) await sleep(10);
  assert.deepEqual(
    done().map((e) => [e.status, e.client_aborted]),
    [[499, true]],
  );
  assert.ok(!logs.some((e) => e.event === 'error'), 'no upstream failure is logged');

  const port = Number(new URL(url).port);
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"model":`,
  );
  await sleep(50);
  socket.destroy();
  for (let i = 0; i < 50 && !logs.some((e) => e.event === 'error'); i += 1) await sleep(10);
  assert.match(String(logs.find((e) => e.event === 'error')?.error), /^the client went away before the request was routed: /);
  await slow.close();
});

test('reload switches new requests to the new config', async () => {
  const { url, server } = await startRouter();
  const next = testConfig();
  const anthropicTargets = next.surfaces.anthropic;
  assert.ok(anthropicTargets);
  anthropicTargets.balanced.model = 'claude-sonnet-5-1';
  server.reload(next);
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const d = await delta(() => post(url, '/v1/messages', cc('s-reload', 'Add a test'), ccHeaders('s-reload')));
  assert.equal(d.anthropic[0].body.model, 'claude-sonnet-5-1');
  assert.equal(d.jevA.length, 1, 'the new config has its own Jev client');
});

test('without a Jev key every session gets the default tier, and the router says why once', async () => {
  const { url, logs, routes } = await startRouter({ env: { TYPESAFE_API_KEY: '', OPENROUTER_API_KEY: '' } });
  const first = cc('s-nojev', 'Design the cache');
  const d1 = await delta(() => post(url, '/v1/messages', first, ccHeaders('s-nojev')));
  assert.equal(d1.anthropic[0].body.model, 'claude-sonnet-5');
  const second = cc('s-nojev', 'Now the eviction', { history: [...first.messages, { role: 'assistant', content: 'ok' }] });
  const d2 = await delta(() => post(url, '/v1/messages', second, ccHeaders('s-nojev')));
  assert.equal(d1.jevA.length + d1.jevB.length + d2.jevA.length + d2.jevB.length, 0);
  assert.deepEqual(
    routes().map((r) => r.reason),
    ['no-jev', 'no-jev'],
  );
  assert.equal(logs.filter((e) => e.event === 'warning' && e.message.startsWith('No Jev channel has a key')).length, 1);
});

test("without a router key, only the client's own provider gets the client's credentials", async () => {
  const { url } = await startRouter({ env: { ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' } });
  const login = { authorization: 'Bearer client-login' };
  reset(plans.a, { option: 'deep', probability: 0.9 });
  const d1 = await delta(() => post(url, '/v1/messages', cc('s-login', 'Design it'), ccHeaders('s-login', login)));
  assert.equal(d1.anthropic[0].headers['x-api-key'], 'client-side-placeholder-key');
  assert.equal(d1.anthropic[0].headers.authorization, 'Bearer client-login');
  reset(plans.a, { option: 'mechanical', probability: 0.99 });
  const d2 = await delta(() => post(url, '/v1/messages', cc('s-login-2', 'List the files'), ccHeaders('s-login-2', login)));
  assert.equal(d2.ollama[0].headers.authorization, undefined, 'Ollama never sees the Anthropic login');
  assert.equal(d2.ollama[0].headers['x-api-key'], undefined);
});

test('a client that leaves mid-stream is logged as gone, and the upstream stream is closed', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url, done } = await startRouter();
  const controller = new AbortController();
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: ccHeaders('s-leave', { 'x-test-chunk-gap-ms': '200' }),
    body: JSON.stringify(claudeCodeBody('s-leave', 'Add a test for the parser')),
    signal: controller.signal,
  });
  assert.ok(res.body);
  await res.body.getReader().read();
  controller.abort();
  await sleep(300);
  const entry = done().at(-1);
  assert.ok(entry);
  assert.equal(entry.status, 200);
  assert.equal(entry.client_aborted, true);
});

test('the router remembers a bounded number of warnings, so pins a client makes up cannot grow it', async () => {
  reset(plans.a, { option: 'routine', probability: 0.9 });
  const { url, logs } = await startRouter();
  await post(url, '/v1/messages', cc('s-pins', 'Add a test'), ccHeaders('s-pins'));
  // Tool-loop steps: no new human turn, so no Jev call, but each pin is read.
  const step = { ...claudeCodeToolTurn('s-pins', 'Add a test'), stream: false };
  const pinned = (/** @type {string} */ pin) => post(url, '/v1/messages', step, ccHeaders('s-pins', { 'x-jev-tier': pin }));
  for (let i = 0; i <= 100; i += 1) await pinned(`made-up-${i}`);
  await pinned('made-up-100');
  await pinned('made-up-0');
  const warnings = () => logs.flatMap((e) => (e.event === 'warning' ? [e.message] : []));
  const pinWarnings = warnings().filter((message) => message.startsWith('Ignoring unknown tier pin'));
  assert.equal(pinWarnings.length, 102, 'each pin once while it is remembered, and the oldest forgotten after 100');
  assert.equal(pinWarnings.at(-1), 'Ignoring unknown tier pin "made-up-0". Known tiers: fast, balanced, frontier.');
  await pinned(`x${'y'.repeat(5000)}`);
  assert.ok(String(warnings().at(-1)).length < 120, 'a long pin is cut');
});

test('logs carry decisions but never keys or prompt text', () => {
  const text = JSON.stringify(allLogs);
  assert.ok(allLogs.length > 30);
  for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), 'a key leaked into the log');
  for (const prompt of ['zero-downtime migration', 'intermittently', AWS_KEY])
    assert.ok(!text.includes(prompt), `prompt text leaked: ${prompt}`);
});
