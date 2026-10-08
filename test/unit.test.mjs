// Unit tests for the parts that need no router: message analysis, secret handling, the tier policy,
// the Jev client (against a fake fetch), config validation, session state, usage accounting and the report.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { parseEnv, promisify } from 'node:util';
import zlib from 'node:zlib';
import { changeSettingsEnv, readSettings, settingsBlock, settingsSet } from '../src/claude.mjs';
import { loadConfig, validateConfig } from '../src/config.mjs';
import { parseKeepAlive } from '../src/duration.mjs';
import { envFileFor, loadEnvFile, quoteEnvValue, setEnvValues } from '../src/envfile.mjs';
import { inPackage, MODEL_CHOICES, PACKAGED_CONFIGS, PACKAGED_DIGESTS, packagedModels, writeFileAtomic } from '../src/files.mjs';
import { commandVersion, installSpec, LEGACY_PACKAGE, npxDirOf, origin, PACKAGE } from '../src/install.mjs';
import {
  applyPolicy,
  buildQuestions,
  buildState,
  hardenState,
  JevClient,
  policyFor,
  prepareQuestions,
  tierProbabilities,
} from '../src/jev.mjs';
import { appendLogLine } from '../src/logfile.mjs';
import { clip, describeCode, harness, header, humanTurns, recentTools, stripWrappers, tierTag } from '../src/messages.mjs';
import { directFetch, parseUiAddress, portProblem } from '../src/net.mjs';
import { PromptAbort, Prompter, typeKeys } from '../src/prompt.mjs';
import { report, requestKind, sessionKey, VERSION } from '../src/router.mjs';
import { findSecrets, mayContainSecret, redactBody, scrub } from '../src/secrets.mjs';
import { renderService, startService } from '../src/service.mjs';
import { hashKey, SessionStore } from '../src/sessions.mjs';
import { rootProblem } from '../src/setup.mjs';
import { costOf, UsageTap } from '../src/usage.mjs';
import { claudeCodeBody, claudeCodeToolTurn, codexBody, jevOptionsAnswer, json, mockServer } from './helpers.mjs';

/** @import { FetchLike, JevConfig, JevState, SessionEntry } from '../src/types.js' */

// Fake credentials for the scanner tests, assembled at runtime so secret scanners don't flag this file.
/** @param {...string} parts */
const fake = (...parts) => parts.join('');
const AWS_KEY = fake('AKIA', 'ABCDEFGHIJKLMNOP');
const PG_URL = fake('postgres://app:', 'hunter2hunter2', '@db:5432/x');
const OPENAI_KEY = fake('sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz0123');
const STRIPE_KEY = fake('sk_', 'live_', 'abcdefghijklmnop1234');
const PEM = fake('-----BEGIN RSA ', 'PRIVATE KEY-----\nabc\n-----END RSA ', 'PRIVATE KEY-----');

// Left as the any that JSON.parse returns: the tests break it in ways no config type allows.
const shipped = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const cfg = validateConfig({ ...shipped, stateFile: null });
const TIERS = cfg.tiers;

test('humanTurns finds what a person typed and skips harness text, tool results and shell-mode output', () => {
  const body = claudeCodeBody('s', 'Fix the login bug');
  assert.deepEqual(
    humanTurns(body).map((t) => t.text),
    ['Fix the login bug'],
  );
  assert.deepEqual(
    humanTurns(claudeCodeToolTurn('s', 'Fix it')).map((t) => t.text),
    ['Fix it'],
    'the tool_result turn is not a human turn',
  );
  const bash = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<bash-input>git log</bash-input>' },
          { type: 'text', text: '<bash-stdout>commit abc</bash-stdout>' },
        ],
      },
    ],
  };
  assert.deepEqual(humanTurns(bash), [], 'shell mode alone is not a prompt');
  const slash = {
    messages: [
      {
        role: 'user',
        content: '<command-name>/review</command-name><command-message>review</command-message><command-args></command-args>',
      },
    ],
  };
  assert.deepEqual(humanTurns(slash), []);
  const image = {
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
  };
  assert.deepEqual(humanTurns(image), [{ index: 0, text: '', images: 1 }], 'an image-only prompt still counts');
  const codex = codexBody('t', 'rename it');
  codex.input.unshift({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nUse tabs.\n</INSTRUCTIONS>' }],
  });
  assert.deepEqual(
    humanTurns(codex).map((t) => t.text),
    ['rename it'],
    'Codex AGENTS.md and environment context are not prompts',
  );
  assert.equal(stripWrappers('<user_shell_command>ls</user_shell_command> why is it empty?'), 'why is it empty?');
});

test('tier tags count only as the first or last typed word, outside code blocks', () => {
  assert.equal(tierTag('#frontier redesign the scheduler', TIERS), 'frontier');
  assert.equal(tierTag('redesign the scheduler #frontier.', TIERS), 'frontier');
  assert.equal(tierTag('speed up the #fast-path lookup', TIERS), undefined);
  assert.equal(tierTag('set RETRIES=3 #fast in the env file and restart', TIERS), undefined, 'mid-sentence is not a tag');
  assert.equal(tierTag('Run this:\n```sh\nRETRIES=3 #fast\n```', TIERS), undefined, 'a tag inside a code block is pasted, not typed');
});

test('clip keeps the start and the end, describeCode summarizes code blocks, recentTools counts calls', () => {
  const long = `${'log line\n'.repeat(1000)}Why does login fail?`;
  const clipped = clip(long, 400);
  assert.ok(clipped.length < 500 && clipped.endsWith('Why does login fail?'));
  assert.equal(describeCode('Fix this:\n```ts\nconst a = 1;\nconst b = 2;\n```'), 'Fix this:\n[code block (ts), 2 lines]');
  const body = claudeCodeToolTurn('s', 'x');
  assert.equal(recentTools(body), 'Bash 1 time');
});

test('secrets: found, scrubbed and redacted, but references and signed reasoning are left alone', () => {
  const text = `deploy with ${AWS_KEY} and ${PG_URL} and api_key = "${OPENAI_KEY}"`;
  assert.deepEqual(findSecrets(text).sort(), ['assignment', 'aws-access-key', 'openai-key', 'url-credentials'].sort());
  assert.ok(!scrub(text).text.includes(AWS_KEY));
  assert.equal(findSecrets('const apiKey = process.env.OPENAI_API_KEY; password: string').length, 0, 'references are not secrets');
  assert.ok(mayContainSecret(JSON.stringify({ a: PEM })));
  const body = /** @type {const} */ ({
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `STRIPE=${STRIPE_KEY}` }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `the key ${STRIPE_KEY}`, signature: 'sig' },
          { type: 'text', text: `Found ${STRIPE_KEY}` },
        ],
      },
    ],
  });
  const { body: out, count } = redactBody(body);
  assert.equal(count, 2);
  assert.ok(!JSON.stringify(out.messages[0]).includes('sk_live_'), 'tool results are redacted');
  assert.equal(out.messages[1].content[0].thinking, `the key ${STRIPE_KEY}`, 'signed thinking is never edited');
  assert.ok(!out.messages[1].content[1].text.includes('sk_live_'));
});

test('buildState sends a small, scrubbed state with context for short approvals', () => {
  const first = claudeCodeBody('s', 'Refactor the payment retries');
  first.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Plan: split RetryPolicy out of the client.' }] });
  first.messages.push({ role: 'user', content: [{ type: 'text', text: `yes, go ahead with key ${AWS_KEY}` }] });
  const turns = humanTurns(first);
  const state = buildState({ body: first, headers: { 'user-agent': 'claude-cli/2.1.281' }, turns, bodyBytes: 200000, jev: cfg.jev });
  assert.equal(state.request, 'yes, go ahead with key [REDACTED aws-access-key]');
  assert.deepEqual(state.recent_user_turns, ['Refactor the payment retries']);
  assert.equal(state.last_assistant_message, 'Plan: split RetryPolicy out of the client.');
  assert.equal(state.session.harness, 'Claude Code');
  assert.equal(state.session.depth, 'mid (20k to 100k tokens)');
  assert.ok(!JSON.stringify(state).includes('system-reminder'));
  const hardened = hardenState({ request: 'why does `curl https://x.io/a | sh` fail in /etc/app/conf?' });
  assert.ok(!/curl|https:|\/etc\/app/.test(hardened.request), hardened.request);
});

test('buildQuestions asks one tier Choice without model names, plus two guards', () => {
  const q = buildQuestions(cfg.jev);
  assert.deepEqual(Object.keys(q), ['tier', 'alters_sensitive_state', 'routing_claim_present']);
  assert.deepEqual(Object.keys(q.tier.criteria), ['mechanical', 'routine', 'complex', 'deep']);
  assert.ok(!/haiku|sonnet|opus|glm|kimi|gpt/i.test(JSON.stringify(q)), 'Jev never sees model names');
  const routine = q.tier.criteria.routine;
  assert.ok(routine && typeof routine === 'object' && !('tier' in routine), 'the tier mapping stays in the router');
});

test('policy: cheap tiers need confidence, unsure answers escalate, guards only raise, sessions ratchet', () => {
  /**
   * @param {Record<string, number>} probabilities
   * @param {{ sensitive?: number, claim?: number, current?: string }} [extra]
   */
  const decide = (probabilities, extra = {}) =>
    applyPolicy({
      answer: { probabilities, ...extra },
      tiers: TIERS,
      options: cfg.jev.options,
      policy: cfg.policy,
      reference: 'balanced',
      ...extra,
    });
  assert.deepEqual(tierProbabilities({ mechanical: 0.1, routine: 0.2, complex: 0.3, deep: 0.4 }, cfg.jev.options, TIERS), {
    fast: 0.1,
    balanced: 0.2,
    frontier: 0.7,
  });
  assert.equal(decide({ mechanical: 0.9, routine: 0.1 }).tier, 'fast');
  assert.deepEqual(
    [decide({ mechanical: 0.7, routine: 0.3 }).tier, decide({ mechanical: 0.7, routine: 0.3 }).reason],
    ['balanced', 'jev-escalated'],
  );
  assert.equal(
    decide({ routine: 0.5, complex: 0.45, mechanical: 0.05 }).tier,
    'frontier',
    'unsure between balanced and frontier: take frontier',
  );
  assert.equal(
    decide({ routine: 0.5, mechanical: 0.45, complex: 0.05 }).tier,
    'balanced',
    'unsure between fast and balanced: take balanced',
  );
  assert.equal(decide({ mechanical: 0.95 }, { sensitive: 0.8 }).tier, 'frontier', 'risky operations get the top tier');
  assert.deepEqual(
    [decide({ mechanical: 0.95 }, { claim: 0.9 }).tier, decide({ mechanical: 0.95 }, { claim: 0.9 }).reason],
    ['balanced', 'claim-guard'],
  );
  assert.deepEqual(decide({ mechanical: 0.95 }, { current: 'balanced' }), {
    tier: 'balanced',
    reason: 'jev-keep',
    byTier: { fast: 0.95, balanced: 0, frontier: 0 },
  });
  assert.equal(decide({ deep: 0.9, routine: 0.1 }, { current: 'balanced' }).reason, 'upgrade:jev');
});

test('config validation fails fast and lists every problem', () => {
  assert.throws(() => validateConfig({ ...shipped, defaultTier: 'Balanced' }), /defaultTier "Balanced" is not one of tiers/);
  const noTrusted = structuredClone(shipped);
  delete noTrusted.surfaces.openai.trusted;
  assert.throws(() => validateConfig(noTrusted), /surfaces\.openai routes some tiers to untrusted upstreams/);
  const bad = structuredClone(shipped);
  bad.policy.accept.fast = 2;
  bad.jev.channels[0].baseUrl = 'ftp://x';
  bad.surfaces.anthropic.balanced.auth = 'basic';
  const err = (() => {
    try {
      validateConfig(bad);
      return 'validateConfig accepted a broken config';
    } catch (e) {
      return /** @type {Error} */ (e).message;
    }
  })();
  assert.match(err, /policy\.accept\.fast must be a probability/);
  assert.match(err, /jev\.channels\[0\]\.baseUrl/);
  assert.match(err, /surfaces\.anthropic\.balanced\.auth/);
  const minimal = structuredClone(shipped);
  delete minimal.sideCallModel;
  delete minimal.policy.sensitiveOverride;
  const filled = validateConfig({ ...minimal, stateFile: null });
  assert.equal(filled.sideCallModel, 'haiku', 'a missing sideCallModel gets a safe default instead of matching everything');
  assert.equal(filled.policy.sensitiveOverride, 0.7);
});

test('the packaged configs validate; the Fable one is the Claude-only one plus a max tier on Fable 5.1', () => {
  /** @param {import('../src/types.js').Models} name */
  const read = (name) => JSON.parse(readFileSync(PACKAGED_CONFIGS[name], 'utf8'));
  for (const name of MODEL_CHOICES) assert.ok(loadConfig(PACKAGED_CONFIGS[name]).tiers.length >= 3, name);
  // Everything else is the Claude-only config's, so a change there has to reach the Fable config too.
  const expected = read('claude');
  expected.tiers.push('max');
  expected.policy.accept.max = 0.3;
  expected.policy.escalationCeiling = 'frontier';
  expected.modelPins.fable = 'max';
  expected.jev.options.deep.tier = 'max';
  expected.surfaces.anthropic.max = { ...expected.surfaces.anthropic.frontier, model: 'claude-fable-5-1' };
  expected.surfaces.openai.max = expected.surfaces.openai.frontier;
  expected.baselineModel.anthropic = 'claude-fable-5-1';
  assert.deepEqual(read('fable'), expected);

  const fable = loadConfig(PACKAGED_CONFIGS.fable);
  const claude = loadConfig(PACKAGED_CONFIGS.claude);
  /**
   * @param {import('../src/types.js').Config} cfg
   * @param {[number, number, number, number]} p mechanical, routine, complex and deep
   * @param {number} [sensitive]
   */
  const tier = (cfg, [mechanical, routine, complex, deep], sensitive = 0) =>
    applyPolicy({
      answer: { probabilities: { mechanical, routine, complex, deep }, sensitive },
      tiers: cfg.tiers,
      options: cfg.jev.options,
      policy: cfg.policy,
      reference: cfg.defaultTier,
    }).tier;
  /** @type {Array<[[number, number, number, number], string]>} */
  const cases = [
    [[0.9, 0.08, 0.01, 0.01], 'fast'],
    [[0.05, 0.85, 0.08, 0.02], 'balanced'],
    [[0, 0.1, 0.8, 0.1], 'frontier'],
    [[0, 0.15, 0.45, 0.4], 'frontier'],
    // Jev unsure: the router takes the more capable of its top two, but no higher than Opus 5.5.
    [[0.1, 0.5, 0.15, 0.25], 'frontier'],
    [[0.84, 0, 0.08, 0.08], 'frontier'],
  ];
  for (const [p, expectedTier] of cases) {
    assert.equal(tier(fable, p), expectedTier, `${p} with Fable`);
    assert.equal(tier(claude, p), expectedTier, `${p}: the Fable config routes like the Claude-only one`);
  }
  assert.equal(tier(fable, [0, 0.05, 0.3, 0.65]), 'max', 'Fable 5.1 when deep is the most likely answer');
  assert.equal(tier(fable, [0.2, 0.2, 0.25, 0.35]), 'max', 'even under its bar: nothing above it to escalate to');
  assert.equal(tier(fable, [0.05, 0.85, 0.08, 0.02], 0.9), 'max', 'the risk override goes to the top tier');
});

test('policy.escalationCeiling caps the unsure path, and only that', () => {
  /**
   * @param {string | undefined} escalationCeiling
   * @param {Record<string, number>} probabilities
   */
  const decide = (escalationCeiling, probabilities) =>
    applyPolicy({
      answer: { probabilities },
      tiers: cfg.tiers,
      options: cfg.jev.options,
      policy: { ...cfg.policy, escalationCeiling },
      reference: cfg.defaultTier,
    });
  const unsure = { mechanical: 0.5, routine: 0.1, complex: 0.4, deep: 0 };
  assert.deepEqual(
    [undefined, 'frontier', 'balanced', 'fast'].map((ceiling) => decide(ceiling, unsure).tier),
    ['frontier', 'frontier', 'balanced', 'fast'],
  );
  assert.equal(decide('balanced', unsure).reason, 'jev-escalated');
  assert.equal(decide('fast', unsure).reason, 'jev', "no step up at all: Jev's pick stands");
  assert.equal(decide('fast', { mechanical: 0, routine: 0.1, complex: 0.9, deep: 0 }).tier, 'frontier', "Jev's top pick isn't capped");
});

test('packagedModels knows unchanged copies of every released packaged config, and inPackage links into the package', () => {
  /** @param {string} file */
  const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const name of MODEL_CHOICES)
    assert.ok(
      PACKAGED_DIGESTS[name].includes(digest(PACKAGED_CONFIGS[name])),
      `config for --models ${name} changed: add its new digest to PACKAGED_DIGESTS in src/files.mjs, and keep the old ones`,
    );
  const dir = mkdtempSync(`${tmpdir()}/jev-packaged-`);
  for (const name of MODEL_CHOICES) {
    copyFileSync(PACKAGED_CONFIGS[name], `${dir}/${name}.json`);
    assert.equal(packagedModels(`${dir}/${name}.json`), name);
  }
  writeFileSync(`${dir}/edited.json`, `${readFileSync(PACKAGED_CONFIGS.claude, 'utf8')} `);
  assert.equal(packagedModels(`${dir}/edited.json`), undefined, 'one byte more is a change');
  assert.equal(packagedModels(`${dir}/missing.json`), undefined);
  const older = { claude: [digest(`${dir}/edited.json`)], fable: [], ollama: [] };
  assert.equal(packagedModels(`${dir}/edited.json`, older), 'claude', 'a copy of an older release counts too');

  symlinkSync(PACKAGED_CONFIGS.claude, `${dir}/linked.json`);
  assert.equal(inPackage(`${dir}/linked.json`), realpathSync(PACKAGED_CONFIGS.claude));
  assert.equal(inPackage(`${dir}/claude.json`), undefined);
  assert.equal(inPackage(`${dir}/missing.json`), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('config validation rejects a maxSessions the session store cannot honor (regression: -1 hung the router)', () => {
  for (const maxSessions of [-1, 0, 'many'])
    assert.throws(() => validateConfig({ ...shipped, stateFile: null, maxSessions }), /maxSessions must be a positive integer/);
  assert.equal(validateConfig({ ...shipped, stateFile: null, maxSessions: 5 }).maxSessions, 5);
});

test('usage tap reads Anthropic and Responses usage from the stream; costOf prices it', () => {
  const tap = new UsageTap('text/event-stream');
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_read_input_tokens":90000,"cache_creation_input_tokens":2000,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n';
  for (const piece of [sse.slice(0, 57), sse.slice(57, 200), sse.slice(200)]) tap.push(Buffer.from(piece));
  const usage = tap.result();
  assert.deepEqual(usage, { input: 10, cacheRead: 90000, cacheWrite: 2000, output: 500 });
  assert.equal(costOf('claude-sonnet-5', usage, cfg.prices), 0.02802); // 10×2 + 90000×0.2 + 2000×2.5 + 500×10 per million
  const responses = new UsageTap('text/event-stream');
  responses.push(
    Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"glm-5.3-flash","usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},"output_tokens":50}}}\n\n',
    ),
  );
  assert.deepEqual(responses.result(), { input: 200, cacheRead: 800, cacheWrite: 0, output: 50 });
  assert.equal(costOf('unknown-model', usage, cfg.prices), undefined);
});

test('the usage tap skips SSE events that are not JSON objects (regression: `data: null` threw and cut the stream)', () => {
  const tap = new UsageTap('text/event-stream');
  tap.push(Buffer.from('data: null\n\ndata: 42\n\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'));
  assert.deepEqual(tap.result(), { input: 0, cacheRead: 0, cacheWrite: 0, output: 5 });
});

test('session keys and request kinds come from what each client sends', () => {
  assert.deepEqual(sessionKey({ 'x-claude-code-session-id': 'A' }, {}), { id: 'A', source: 'claude-code-header' });
  assert.equal(sessionKey({}, { metadata: { user_id: JSON.stringify({ session_id: 'B' }) } }).id, 'B');
  assert.equal(sessionKey({ 'thread-id': 'T', 'session-id': 'S' }, {}).id, 'S');
  assert.equal(sessionKey({}, { prompt_cache_key: 'P' }).source, 'prompt-cache-key');
  assert.equal(sessionKey({}, claudeCodeBody('_', 'x')).source, 'claude-code-metadata');
  const anon = claudeCodeBody('_', 'Refactor auth');
  delete anon.metadata;
  assert.match(sessionKey({}, anon).id, /^h:[0-9a-f]{64}$/);
  assert.equal(requestKind({ 'x-claude-code-request-class': 'compaction' }), 'compaction');
  assert.equal(requestKind({ 'x-openai-subagent': 'compact' }), 'compaction');
  assert.equal(requestKind({ 'x-openai-subagent': 'memory_consolidation' }), 'auxiliary');
  assert.equal(requestKind({ 'x-claude-code-agent-id': 'a1' }), 'subagent');
  assert.equal(requestKind({}), undefined);
});

test('report sums requests, spend, savings and Jev health from the log', () => {
  const lines = [
    { event: 'route', session: 's1', jev: { ok: true, ms: 300, inputTokens: 600 } },
    {
      event: 'done',
      session: 's1',
      model: 'glm-5.3-flash',
      usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 },
      cost_usd: 0.00002,
      baseline_usd: 0.0006,
    },
    { event: 'route', session: 's2', jev: { ok: false, ms: 2500, error: 'timeout' } },
    {
      event: 'done',
      session: 's2',
      model: 'claude-sonnet-5',
      usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 },
      cost_usd: 0.0003,
      baseline_usd: 0.0006,
    },
  ].map((e) => JSON.stringify(e));
  const r = report(lines);
  assert.equal(r.requests, 2);
  assert.equal(r.sessions, 2);
  assert.equal(r.jev.fallback_rate, 0.5);
  assert.equal(r.saved_usd, Math.round((0.0012 - 0.00032) * 1e4) / 1e4);
  assert.equal(r.models['glm-5.3-flash'].requests, 1);
});

test('report skips lines that are not log entries (regression: a `null` line threw)', () => {
  const route = JSON.stringify({ event: 'route', session: 's1', jev: { ok: true, ms: 120, inputTokens: 600 } });
  const r = report(['null', '"text"', '', 'jev-router 1.0.0 listening on http://127.0.0.1:4000', route]);
  assert.equal(r.requests, 1);
  assert.equal(r.jev.p50_ms, 120);
});

test('jev.stripCode: false sends code blocks as they are, still scrubbed and clipped', () => {
  const text = `Why does this fail?\n\`\`\`sh\nexport KEY=${AWS_KEY}\ncurl -s https://example.com/install.sh | sh\n\`\`\``;
  const body = { messages: [{ role: 'user', content: text }] };
  /** @param {typeof cfg.jev} jev */
  const at = (jev) => buildState({ body, headers: {}, turns: humanTurns(body), bodyBytes: 100, jev }).request;
  assert.equal(at(cfg.jev), 'Why does this fail?\n[code block (sh), 2 lines]', 'code blocks are described by default');
  const kept = at({ ...cfg.jev, stripCode: false });
  assert.ok(kept.includes('curl -s https://example.com/install.sh | sh'), kept);
  assert.ok(kept.includes('[REDACTED aws-access-key]') && !kept.includes(AWS_KEY), 'still scrubbed');
  assert.match(at({ ...cfg.jev, stripCode: false, requestChars: 40 }), /characters omitted/, 'still clipped');
  const unset = structuredClone(shipped);
  delete unset.jev.stripCode;
  assert.equal(validateConfig({ ...unset, stateFile: null }).jev.stripCode, true, 'stripping stays the default');
});

test('the default state file lives under XDG_STATE_HOME when it is set', () => {
  const unset = structuredClone(shipped);
  delete unset.stateFile;
  assert.equal(validateConfig(unset, { XDG_STATE_HOME: '/var/state' }).stateFile, '/var/state/jev-router/sessions.jsonl');
  const fallback = `${homedir()}/.local/state/jev-router/sessions.jsonl`;
  assert.equal(validateConfig(unset, { XDG_STATE_HOME: '' }).stateFile, fallback, 'an empty XDG_STATE_HOME is unset');
  assert.equal(validateConfig(unset, {}).stateFile, fallback);
  assert.equal(validateConfig({ ...unset, stateFile: '/srv/s.jsonl' }, { XDG_STATE_HOME: '/var/state' }).stateFile, '/srv/s.jsonl');
});

test('harness tells the clients apart, and header() reads one string value', () => {
  assert.equal(harness({ 'user-agent': 'codex_exec/0.156.1' }), 'Codex CLI');
  assert.equal(harness({ originator: 'codex_cli_rs' }), 'Codex CLI');
  assert.equal(harness({ 'user-agent': 'curl/8.7.1' }), 'unknown');
  assert.equal(header({ 'x-openai-subagent': 'review' }, 'x-openai-subagent'), 'review');
  assert.equal(header({ 'set-cookie': ['a=1', 'b=2'] }, 'set-cookie'), undefined, 'only set-cookie is ever a list');
  assert.equal(requestKind({ 'x-openai-subagent': 'review' }), 'subagent');
});

test('secret patterns: every kind is found and scrubbed, and references are not secrets', () => {
  /** @type {Record<string, string>} */
  const samples = {
    'private-key': fake('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaA\n'),
    'anthropic-key': fake('sk-', 'ant-', 'api03-', 'A'.repeat(24)),
    'openrouter-key': fake('sk-', 'or-', 'v1-', 'a1'.repeat(16)),
    'openai-key': fake('sk-', 'svcacct-', 'b'.repeat(24)),
    'aws-access-key': fake('ASIA', 'ZYXWVUTSRQPONMLK'),
    'aws-secret-key': fake('aws_secret_', 'access_key = ', 'A'.repeat(40)),
    'github-token': fake('gh', 'p_', 'c'.repeat(36)),
    'gitlab-token': fake('gl', 'pat-', 'd'.repeat(20)),
    'slack-token': fake('xo', 'xb-', '1234567890-abc'),
    'stripe-key': fake('rk_', 'test_', 'e'.repeat(16)),
    'google-api-key': fake('AI', 'za', 'f'.repeat(35)),
    'pulumi-token': fake('pul-', 'a'.repeat(40)),
    jwt: fake('ey', 'JhbGciOiJIUzI1', '.ey', 'JzdWIiOiIxMjM0', '.', 'signature12'),
    'url-credentials': fake('https://deploy:', 's3cretpass', '@git.example.com/repo.git'),
    assignment: fake('client_secret: "', 'q'.repeat(12), '"'),
  };
  for (const [kind, sample] of Object.entries(samples)) {
    assert.ok(findSecrets(`before ${sample} after`).includes(kind), kind);
    assert.ok(mayContainSecret(sample), `${kind}: the quick check agrees`);
    assert.ok(scrub(sample).text.includes(`[REDACTED ${kind}]`), `${kind} is scrubbed`);
  }
  assert.ok(findSecrets(fake('github_', 'pat_', 'g'.repeat(40))).includes('github-token'));
  assert.ok(findSecrets(fake('sk-', 'h'.repeat(40))).includes('openai-key'));
  const references = [
    'password = $DB_PASSWORD',
    fake('password = $', '{DB_PASSWORD}'),
    'api_key: <your-key-here>',
    'auth_token: {{ secrets.TOKEN }}',
    'secret = os.environ["APP_SECRET"]',
    'password: ***hidden***',
    'apiKey = env.API_KEY',
    'pwd=short',
  ];
  for (const text of references) assert.deepEqual(findSecrets(text), [], text);
  assert.deepEqual(scrub('nothing to see').count, 0);
});

test('loadConfig reads and validates a file, and names the file it cannot read', () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-config-`);
  assert.throws(() => loadConfig(`${dir}/missing.json`), /^Error: Cannot read config .*missing\.json: ENOENT/);
  writeFileSync(`${dir}/broken.json`, '{ "tiers": [');
  assert.throws(() => loadConfig(`${dir}/broken.json`), /Cannot read config .*broken\.json: /);
  writeFileSync(`${dir}/ok.json`, JSON.stringify({ ...shipped, stateFile: '~/state/s.jsonl', logFile: '~/logs/router.log' }));
  const loaded = loadConfig(`${dir}/ok.json`, {});
  assert.equal(loaded.stateFile, `${homedir()}/state/s.jsonl`, 'a leading ~ is the home directory');
  assert.equal(loaded.logFile, `${homedir()}/logs/router.log`);
  assert.equal(loadConfig(new URL(`file://${dir}/ok.json`)).port, 4000, 'a file URL works too');
});

test('config validation names each kind of problem', () => {
  /** @type {Array<[(raw: typeof shipped) => void, RegExp]>} */
  const cases = [
    [(c) => (c.port = 0), /port must be an integer between 1 and 65535/],
    [(c) => (c.allowedHosts = 'localhost:4000'), /allowedHosts must be an array/],
    [(c) => (c.tiers = []), /tiers must list tier names/],
    [(c) => (c.policy.mode = 'eager'), /policy\.mode must be "ratchet" or "sticky"/],
    [(c) => (c.policy.accept.turbo = 0.5), /policy\.accept names unknown tier "turbo"/],
    [(c) => (c.policy.claimGuard = 1.5), /policy\.claimGuard must be a probability/],
    [(c) => (c.policy.escalationCeiling = 'top'), /policy\.escalationCeiling "top" is not one of tiers/],
    [(c) => (c.jev.channels = [{ baseUrl: 'https://jev.example' }]), /jev\.channels\[0\]\.name is required/],
    [(c) => (c.jev.channels = [{ name: 'x', baseUrl: 'https://jev.example' }]), /jev\.channels\[0\]\.model is required/],
    [(c) => (c.jev.channels = [{ name: 'x', baseUrl: 'https://jev.example', model: 'm' }]), /jev\.channels\[0\]\.keyEnv is required/],
    [(c) => (c.jev.channels = [{ name: 'x', baseUrl: 'http://10.1.2.3:11434', model: 'nimble' }]), /only allowed on a loopback address/],
    [
      (c) => (c.jev.channels = [{ name: 'x', baseUrl: 'http://alice:example@127.0.0.1:11434', model: 'nimble' }]),
      /baseUrl must not carry a user or password/,
    ],
    [(c) => (c.jev.channels[0].thresholds = { accept: { turbo: 0.5 } }), /thresholds\.accept names unknown tier "turbo"/],
    [(c) => (c.jev.channels[0].thresholds = { sensitiveOverride: 2 }), /thresholds\.sensitiveOverride must be a probability/],
    [(c) => (c.jev.question = ''), /jev\.question is required/],
    [(c) => (c.jev.options = { only: { tier: 'fast' } }), /jev\.options needs at least two options/],
    [(c) => (c.jev.options.routine.tier = 'turbo'), /jev\.options\.routine\.tier must be one of tiers/],
    [(c) => delete c.surfaces, /surfaces is required/],
    [(c) => delete c.surfaces.anthropic.frontier, /surfaces\.anthropic has no target for tier "frontier"/],
    [(c) => (c.surfaces.openai.frontier.url = 'not a url'), /surfaces\.openai\.frontier\.url must be an http\(s\) URL/],
    [(c) => (c.surfaces.openai.frontier.model = ''), /surfaces\.openai\.frontier\.model is required/],
    [(c) => delete c.surfaces.openai.frontier.keyEnv, /surfaces\.openai\.frontier needs keyEnv or clientAuth/],
    [(c) => (c.surfaces.anthropic.side.omit = 'thinking'), /surfaces\.anthropic\.side\.omit must be a list of field paths/],
    [(c) => (c.surfaces.anthropic.side.maxOutputTokens = 0), /surfaces\.anthropic\.side\.maxOutputTokens must be a positive whole number/],
    [(c) => (c.surfaces.anthropic.side.foldSystemMessages = 'yes'), /surfaces\.anthropic\.side\.foldSystemMessages must be true or false/],
    [(c) => (c.surfaces.anthropic.side.omitBetas = 'context-1m'), /surfaces\.anthropic\.side\.omitBetas must be a list of beta names/],
    [(c) => (c.modelPins.opus = 'turbo'), /modelPins\.opus must be one of tiers/],
    [(c) => (c.host = ''), /host must be an address or a host name/],
    [(c) => (c.allowedHosts = ['localhost:4000', 4000]), /allowedHosts must be an array of host\[:port\] strings/],
    [(c) => (c.allowedOrigins = 'https://app.example'), /allowedOrigins must be an array of origins/],
    [(c) => (c.maxBodyBytes = '32mb'), /maxBodyBytes must be a whole number of bytes above 0/],
    [(c) => (c.maxBodyBytes = 0), /maxBodyBytes must be a whole number of bytes above 0/],
    [(c) => (c.sideCallModel = '('), /sideCallModel must be a regular expression/],
    [(c) => (c.pinOnModelChange = 'false'), /pinOnModelChange must be true or false/],
    [(c) => (c.policy.maxProvisional = -1), /policy\.maxProvisional must be a whole number, 0 or more/],
    [(c) => (c.policy.idleResetMinutes = '10'), /policy\.idleResetMinutes must be a number of minutes/],
    [(c) => (c.policy.failClosed = 'false'), /policy\.failClosed must be true or false/],
    [(c) => (c.jev.deadlineMs = '2500'), /jev\.deadlineMs must be a whole number of milliseconds above 0/],
    [(c) => (c.jev.requestChars = 0), /jev\.requestChars must be a whole number above 0/],
    [(c) => (c.jev.stripCode = 'no'), /jev\.stripCode must be true or false/],
    [(c) => (c.jev.guards = 1), /jev\.guards must be true or false/],
    [(c) => (c.jev.channels[0].timeoutMs = 'fast'), /jev\.channels\[0\]\.timeoutMs must be a whole number of milliseconds above 0/],
  ];
  for (const [change, message] of cases) {
    const raw = structuredClone(shipped);
    change(raw);
    assert.throws(() => validateConfig({ ...raw, stateFile: null }), message, String(message));
  }
  // A number would be taken for a file descriptor.
  assert.throws(() => validateConfig({ ...shipped, stateFile: 5 }), /stateFile must be a file path or null/);
  assert.equal(
    validateConfig({ ...shipped, stateFile: null, policy: { ...shipped.policy, idleResetMinutes: 0.5 } }).policy.idleResetMinutes,
    0.5,
  );
});

/** @type {(request: string) => JevState} */
const stateOf = (request) => ({ request, session: { harness: 'Claude Code', depth: 'new session' } });
/** @type {JevConfig} */
const JEV = {
  ...cfg.jev,
  deadlineMs: 2000,
  channels: [
    { name: 'one', baseUrl: 'http://one.invalid', model: 'jev-1.13.0', keyEnv: 'ONE_KEY', timeoutMs: 500 },
    { name: 'two', baseUrl: 'http://two.invalid/', model: 'jev-1.13.0', keyEnv: 'TWO_KEY', timeoutMs: 500 },
  ],
};
/**
 * @param {number} status
 * @param {unknown} body a string is sent as is
 * @param {Record<string, string>} [headers]
 */
const reply = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const good = () => reply(200, jevOptionsAnswer({ option: 'routine', probability: 0.9 }));

/**
 * A reply that never comes: it waits for the call's signal. The pending timer keeps the event loop
 * alive meanwhile, which AbortSignal.timeout's own timer doesn't.
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
const hang = (init) =>
  new Promise((_, reject) => {
    const alive = setTimeout(() => reject(new Error('the call was never aborted')), 5000);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(alive);
      reject(init.signal?.reason);
    });
  });

/**
 * A Jev client whose channels answer from a script: each host's replies are used up in order.
 * @param {Record<string, Array<(init: RequestInit) => Response | Promise<Response>>>} script
 * @param {{ env?: Record<string, string>, jev?: JevConfig, now?: () => number }} [options]
 */
function scripted(script, { env = { ONE_KEY: 'key-one', TWO_KEY: 'key-two' }, jev = JEV, now = Date.now } = {}) {
  /** @type {Array<{ host: string, init: RequestInit }>} */
  const calls = [];
  /** @type {FetchLike} */
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host;
    calls.push({ host, init });
    const next = script[host]?.shift();
    if (!next) throw new Error(`no scripted reply for ${host}`);
    return next(init);
  };
  return { client: new JevClient(jev, env, { fetchImpl, now }), calls };
}

test('Jev client: 401, 402 and a JSON 403 skip the channel for five minutes and move on', async () => {
  for (const status of [401, 402, 403]) {
    const { client, calls } = scripted({
      'one.invalid': [() => reply(status, { error: { message: 'bad key' } })],
      'two.invalid': [good, good],
    });
    const before = Date.now();
    const answer = await client.decide(stateOf('Add a test'));
    assert.ok(answer.ok && answer.channel === 'two', `${status}: the next channel answers`);
    const one = client.health().one;
    assert.equal(one.open, true);
    assert.ok(one.openUntil >= before + 300000 && one.openUntil <= Date.now() + 300000, `${status}: open for five minutes`);
    assert.equal(one.lastError, `HTTP ${status} bad key`);
    await client.decide(stateOf('Add another test'));
    assert.deepEqual(
      calls.map((c) => c.host),
      ['one.invalid', 'two.invalid', 'two.invalid'],
      `${status}: the open channel gets no call`,
    );
  }
});

test('Jev client: a 422, a body that is not JSON and an answer without a tier fail over without the breaker', async () => {
  const failures = [
    [() => reply(422, { detail: 'state too large' }), 'HTTP 422 state too large'],
    [() => reply(422, { detail: { message: 'bad state' } }), 'HTTP 422 bad state'],
    [() => reply(400, 'plain text error', { 'content-type': 'text/plain' }), 'HTTP 400 plain text error'],
    [() => reply(200, 'not json'), 'response is not JSON'],
    [() => reply(200, { answers: {} }), 'response has no tier answer'],
    [() => reply(200, { answers: { tier: { choice: 'nope' } } }), 'response has no tier answer'],
  ];
  for (const [failure, error] of /** @type {Array<[() => Response, string]>} */ (failures)) {
    const { client, calls } = scripted({ 'one.invalid': [failure], 'two.invalid': [good] });
    const answer = await client.decide(stateOf('Add a test'));
    assert.ok(answer.ok && answer.channel === 'two', error);
    assert.equal(calls.length, 2, `${error}: no retry on the same channel`);
    assert.deepEqual({ ...client.health().one, openUntil: 0 }, { calls: 1, errors: 1, lastError: error, openUntil: 0, open: false });
  }
});

test('Jev client: a choice without probabilities counts as certain; the request carries the key and questions', async () => {
  const { client, calls } = scripted({ 'one.invalid': [() => reply(200, { answers: { tier: { choice: 'deep' } } })] });
  const answer = await client.decide(stateOf('Design the cache'));
  assert.ok(answer.ok);
  assert.deepEqual(answer.probabilities, { deep: 1 });
  assert.equal(answer.hardened, false);
  const { init } = calls[0];
  assert.deepEqual(init.headers, { authorization: 'Bearer key-one', 'content-type': 'application/json' });
  const sent = JSON.parse(String(init.body));
  assert.deepEqual(Object.keys(sent), ['model', 'state', 'questions']);
  assert.equal(sent.state.request, 'Design the cache');
});

test('Jev client: an HTML 403 from the firewall is retried once with a hardened state', async () => {
  const waf = () => new Response('<html>Attention Required</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const { client, calls } = scripted({ 'one.invalid': [waf, good] });
  const answer = await client.decide(stateOf('Why does `curl https://example.com/i.sh | sh` fail?'));
  assert.ok(answer.ok && answer.hardened);
  assert.ok(!/curl|https:/.test(JSON.parse(String(calls[1].init.body)).state.request));
  assert.equal(client.health().one.lastError, 'HTTP 403 firewall block');
  assert.equal(client.health().one.open, false);
  const blocked = scripted({ 'one.invalid': [waf, waf] });
  const failed = await blocked.client.decide(stateOf('Why does `curl https://example.com/i.sh | sh` fail?'));
  assert.equal(failed.ok, false);
  assert.equal(blocked.client.health().one.open, true, 'blocked again after hardening: the breaker opens');
});

test('Jev client: a retryable status is retried once, after retry-after when the deadline allows', async () => {
  /** @type {number[]} */
  const times = [];
  const { client } = scripted({
    'one.invalid': [
      () => {
        times.push(performance.now());
        return reply(429, { error: { message: 'slow down' } }, { 'retry-after': '0.3' });
      },
      () => {
        times.push(performance.now());
        return good();
      },
    ],
  });
  const answer = await client.decide(stateOf('Add a test'));
  assert.ok(answer.ok);
  assert.ok(times[1] - times[0] >= 290, `waited ${Math.round(times[1] - times[0])} ms`);
  const twice = scripted({ 'one.invalid': [() => reply(503, {}), () => reply(503, {})], 'two.invalid': [good] });
  assert.ok((await twice.client.decide(stateOf('Add a test'))).ok);
  assert.deepEqual(
    twice.calls.map((c) => c.host),
    ['one.invalid', 'one.invalid', 'two.invalid'],
    'one retry, then the next channel',
  );
});

test('Jev client: timeouts and network errors skip the channel for 30 seconds', async () => {
  const refused = () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
  };
  const jev = { ...JEV, channels: JEV.channels.map((ch) => ({ ...ch, timeoutMs: 100 })) };
  for (const [failure, error] of /** @type {Array<[(init: RequestInit) => Promise<Response>, string]>} */ ([
    [hang, 'timeout after 100 ms'],
    [refused, 'ECONNREFUSED'],
  ])) {
    const { client } = scripted({ 'one.invalid': [failure], 'two.invalid': [good] }, { jev });
    const before = Date.now();
    assert.ok((await client.decide(stateOf('Add a test'))).ok);
    const one = client.health().one;
    assert.equal(one.lastError, error);
    assert.ok(one.open && one.openUntil >= before + 30000 && one.openUntil <= Date.now() + 30000, `${error}: open for 30 s`);
  }
});

test('Jev client: a client that goes away ends the decision without counting an error', async () => {
  const controller = new AbortController();
  const { client } = scripted({ 'one.invalid': [hang] });
  setTimeout(() => controller.abort(), 50);
  const answer = await client.decide(stateOf('Add a test'), { signal: controller.signal });
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && answer.aborted && answer.error === 'client went away');
  assert.equal(client.health().one.errors, 0);
});

test('Jev client: a client gone before the first call or between retries is an abort, not a Jev failure', async () => {
  const gone = scripted({ 'one.invalid': [good] });
  const before = await gone.client.decide(stateOf('Add a test'), { signal: AbortSignal.abort() });
  assert.ok(!before.ok && before.aborted, 'already gone: aborted');
  assert.equal(gone.calls.length, 0, 'and no call is made');
  const controller = new AbortController();
  const retrying = scripted({ 'one.invalid': [() => reply(503, {}, { 'retry-after': '0.3' }), good], 'two.invalid': [good] });
  setTimeout(() => controller.abort(), 100);
  const between = await retrying.client.decide(stateOf('Add a test'), { signal: controller.signal });
  assert.ok(!between.ok && between.aborted && between.error === 'client went away', 'gone while waiting to retry: aborted');
  assert.deepEqual(
    retrying.calls.map((call) => call.host),
    ['one.invalid'],
    'no retry and no next channel',
  );
});

test('Jev client: JEV_BASE_URL and JEV_API_KEY add a channel in front; keyless channels are dropped', async () => {
  const env = { JEV_BASE_URL: 'http://env.invalid', JEV_API_KEY: 'key-env', JEV_MODEL: 'jev-1.14.0' };
  const { client, calls } = scripted({ 'env.invalid': [good] }, { env });
  assert.deepEqual(Object.keys(client.health()), ['env'], 'config channels without a key are dropped');
  assert.ok((await client.decide(stateOf('Add a test'))).ok);
  assert.deepEqual(calls[0].init.headers, { authorization: 'Bearer key-env', 'content-type': 'application/json' });
  assert.equal(JSON.parse(String(calls[0].init.body)).model, 'jev-1.14.0');
  const none = new JevClient(JEV, {});
  assert.equal(none.configured, false);
  const nothing = await none.decide(stateOf('Add a test'));
  assert.ok(!nothing.ok && nothing.error === 'no Jev channel is configured');
});

test('a keyless loopback channel is used, sends no key, and records its model', async () => {
  const local = {
    ...JEV,
    channels: [{ name: 'ollama', baseUrl: 'http://127.0.0.1:11435', model: 'nimble', timeoutMs: 500 }],
  };
  const { client, calls } = scripted(
    { '127.0.0.1:11435': [() => reply(200, { answers: { tier: { choice: 'routine', probabilities: { routine: 0.8 } } } })] },
    { jev: local, env: { TYPESAFE_API_KEY: 'hosted-key', JEV_API_KEY: 'other-key' } },
  );
  assert.equal(client.configured, true);
  const answer = await client.decide(stateOf('Rename tmp to total'));
  assert.ok(answer.ok);
  assert.equal(answer.channel, 'ollama');
  assert.equal(answer.model, 'nimble', 'the channel model is recorded when the server omits one');
  assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' }, 'no configured key is sent');
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.model, 'nimble');
  assert.equal(typeof sent.questions.tier.criteria.routine, 'string', 'Ollama gets a description, not the structured criterion');
  assert.ok(sent.questions.alters_sensitive_state && sent.questions.routing_claim_present);
  for (const baseUrl of ['http://localhost:11434', 'http://[::1]:11434', 'http://127.4.5.6:11434']) {
    assert.equal(
      validateConfig({ ...shipped, stateFile: null, jev: { ...shipped.jev, channels: [{ name: 'ollama', baseUrl, model: 'tev1' }] } }).jev
        .channels[0].model,
      'tev1',
    );
  }
  assert.ok(
    validateConfig({ ...shipped, stateFile: null }, { JEV_BASE_URL: 'http://10.1.2.3:11434' }),
    'a keyless remote JEV_BASE_URL leaves the config valid',
  );
  const remote = new JevClient(JEV, { JEV_BASE_URL: 'http://10.1.2.3:11434' });
  assert.equal(remote.configured, false, 'a keyless non-loopback env channel is not called');
  const envLocal = scripted(
    {
      '127.0.0.1:11435': [
        () => reply(200, { model: 'nimble', answers: { tier: { choice: 'mechanical', probabilities: { mechanical: 1 } } } }),
      ],
    },
    { env: { JEV_BASE_URL: 'http://127.0.0.1:11435' } },
  );
  const fromEnv = await envLocal.client.decide(stateOf('Add a test'));
  assert.ok(fromEnv.ok && fromEnv.model === 'nimble' && fromEnv.channel === 'env');
  const envCall = envLocal.calls[0];
  assert.ok(envCall);
  assert.equal(JSON.parse(String(envCall.init.body)).model, 'nimble');
  assert.equal(/** @type {Record<string, string>} */ (envCall.init.headers).authorization, undefined);
});

test('a loopback Jev call skips HTTP_PROXY under NODE_USE_ENV_PROXY, which the global fetch does not', async () => {
  const jev = await mockServer((_call, res) => json(res, 200, jevOptionsAnswer({ option: 'routine', probability: 0.9 })));
  // The global fetch tunnels through the proxy with CONNECT, even for http.
  const proxy = await mockServer((_call, res) => json(res, 502, { proxied: true }));
  /** @type {string[]} */
  const tunnels = [];
  proxy.server.on('connect', (req, socket) => {
    tunnels.push(req.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  try {
    const channels = [
      { name: 'ollama', baseUrl: jev.url, model: 'nimble', timeoutMs: 1000 },
      { name: 'gateway', baseUrl: jev.url, model: 'jev-1.13.0', keyEnv: 'GATEWAY_KEY', timeoutMs: 1000 },
    ];
    const script = `
      const { JevClient } = await import(${JSON.stringify(new URL('../src/jev.mjs', import.meta.url).href)});
      const jev = { ...${JSON.stringify(JEV)}, channels: ${JSON.stringify(channels)} };
      const decisions = [];
      for (const ch of jev.channels) {
        const client = new JevClient({ ...jev, channels: [ch] }, { GATEWAY_KEY: 'gateway-key' });
        decisions.push((await client.decide({ request: 'Add a test', session: { harness: 'Claude Code', depth: 'new session' } })).ok);
      }
      const global = await fetch(${JSON.stringify(`${jev.url}/global`)}).then((res) => res.status, (err) => err.message);
      process.stdout.write(JSON.stringify({ decisions, global }));
    `;
    const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy.url, http_proxy: proxy.url, NO_PROXY: '', no_proxy: '' };
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 10000 });
    const out = JSON.parse(stdout);
    assert.equal(out.global, 'fetch failed', 'the global fetch goes through the proxy, which refuses it');
    assert.deepEqual(out.decisions, [true, true], 'keyless and keyed loopback channels both answer');
    assert.equal(jev.calls.length, 2, 'both decisions reached the Jev server directly');
    assert.deepEqual(tunnels, [new URL(jev.url).host], 'the proxy saw only the global fetch, so the setup is live');
    assert.deepEqual(proxy.calls, [], 'and never a decision');
  } finally {
    await Promise.all([jev.close(), proxy.close()]);
  }
});

test('a loopback server that sends a status fetch cannot represent, or a body that does not decode, fails the decision instead of the router', {
  timeout: 10000,
}, async () => {
  const answer = JSON.stringify(jevOptionsAnswer({ option: 'routine', probability: 0.9 }));
  /** @type {Array<(res: import('node:http').ServerResponse) => void>} */
  const replies = [
    (res) => res.writeHead(600, { 'content-type': 'application/json' }).end(answer),
    (res) => res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end('not gzip at all'),
  ];
  const server = await mockServer((_call, res) => replies.shift()?.(res));
  try {
    // A failed channel is skipped for 30 seconds, so each reply gets a fresh client.
    const client = () =>
      new JevClient({ ...JEV, channels: [{ name: 'ollama', baseUrl: server.url, model: 'nimble', timeoutMs: 1000 }] }, {});
    const first = await client().decide(stateOf('Add a test'));
    assert.ok(!first.ok && first.error.includes('HTTP 600'), 'the status is named');
    const second = await client().decide(stateOf('Add a test'));
    assert.ok(!second.ok && /HTTP 200/.test(second.error), 'a body that does not decode is an error too');
  } finally {
    await server.close();
  }
});

test('a loopback answer compressed with gzip, deflate (zlib or raw), br, or a list of them is decoded, as the global fetch does', async () => {
  const answer = JSON.stringify(jevOptionsAnswer({ option: 'routine', probability: 0.9 }));
  const codings = /** @type {const} */ ([
    ['gzip', zlib.gzipSync],
    ['deflate', zlib.deflateSync],
    ['deflate', zlib.deflateRawSync],
    ['br', zlib.brotliCompressSync],
    ['gzip, br', (/** @type {string} */ body) => zlib.brotliCompressSync(zlib.gzipSync(body))],
  ]);
  const queue = [...codings];
  const server = await mockServer((_call, res) => {
    const [coding, encode] = /** @type {(typeof codings)[number]} */ (queue.shift());
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': coding }).end(encode(answer));
  });
  try {
    const client = new JevClient({ ...JEV, channels: [{ name: 'ollama', baseUrl: server.url, model: 'nimble', timeoutMs: 1000 }] }, {});
    for (const [coding] of codings) assert.equal((await client.decide(stateOf('Add a test'))).ok, true, coding);
  } finally {
    await server.close();
  }
});

test('the direct fetch decodes the edge cases of Content-Encoding exactly as the global fetch does', async () => {
  const body = '{"a":1}';
  const gzip = (/** @type {Buffer | string} */ b) => zlib.gzipSync(b);
  const full = gzip(body);
  const nested = (/** @type {number} */ n) => Array.from({ length: n }).reduce((/** @type {Buffer} */ b) => gzip(b), Buffer.from(body));
  /** @type {Array<[string, Buffer]>} */
  const cases = [
    ['deflate, gzip', gzip(Buffer.alloc(0))],
    ['gzip,', full],
    ['GZIP', full],
    ['gzip', full.subarray(0, full.length - 4)],
    ['gzip, zstd', full],
    [Array(5).fill('gzip').join(', '), nested(5)],
    [Array(6).fill('gzip').join(', '), nested(6)],
  ];
  let n = 0;
  // Each case is asked twice, once by each fetch.
  const server = await mockServer((_call, res) => {
    const [coding, bytes] = cases[Math.floor(n++ / 2)];
    res.writeHead(200, { 'content-encoding': coding }).end(bytes);
  });
  /** @param {() => Promise<Response>} get */
  const read = (get) =>
    get()
      .then(async (res) => Buffer.from(await res.arrayBuffer()).toString('hex'))
      .catch(() => 'rejected');
  try {
    for (const [coding] of cases) {
      const expected = await read(() => fetch(server.url));
      assert.equal(await read(() => directFetch(server.url, {})), expected, coding);
    }
  } finally {
    await server.close();
  }
});

test('the direct fetch refuses a URL with a user or password, as fetch does, and sends nothing', async () => {
  const server = await mockServer((_call, res) => json(res, 200, {}));
  try {
    const url = new URL(server.url);
    url.username = 'alice';
    url.password = 'example';
    await assert.rejects(
      directFetch(url.href, { method: 'POST', body: '{}' }),
      (err) => err instanceof TypeError && err.message === 'fetch failed',
    );
    await assert.rejects(fetch(url.href, { method: 'POST', body: '{}' }), TypeError);
    assert.equal(server.calls.length, 0);
  } finally {
    await server.close();
  }
});

test('parseKeepAlive reads numbers as seconds and strings as Go durations, with negatives meaning forever', () => {
  for (const [value, ms] of [
    [600, 600000],
    [0.5, 500],
    ['1ns', 0.000001],
    ['1us', 0.001],
    ['1µs', 0.001],
    ['1μs', 0.001],
    ['1ms', 1],
    ['1s', 1000],
    ['1m', 60000],
    ['1h', 3600000],
    ['1h30m', 5400000],
    ['1m0.5s', 60500],
    ['.5s', 500],
    ['1.s', 1000],
    ['+1s', 1000],
    [-1, Infinity],
    ['-1m', Infinity],
    ['-1h30m', Infinity],
    [0, 0],
    ['0s', 0],
    ['-0m', 0],
  ])
    assert.equal(parseKeepAlive(value), ms, String(value));
  for (const value of [
    '',
    ' ',
    '600',
    '.5',
    '-1',
    '0',
    'banana',
    '1d',
    '1m 30s',
    '1m-30s',
    '1e3',
    '1e3s',
    '1..2s',
    's',
    '.',
    null,
    true,
    {},
    Infinity,
    NaN,
    '9'.repeat(400),
  ])
    assert.equal(parseKeepAlive(value), undefined, String(value));
});

test('keepAlive takes durations Ollama accepts, from 1 second up, only on keyless loopback channels', () => {
  /** @param {unknown} keepAlive @param {object} [extra] */
  const config = (keepAlive, extra = {}) => ({
    ...shipped,
    stateFile: null,
    jev: { ...shipped.jev, channels: [{ name: 'local', baseUrl: 'http://localhost', model: 'nimble', keepAlive, ...extra }] },
  });
  for (const value of ['10m', '1h', '1s', '1h30m', '2562047h', '-2562047h', 600, 1, -1, '-1m'])
    assert.equal(validateConfig(config(value)).jev.channels[0].keepAlive, value);
  for (const value of ['', ' ', 'banana', '10', '-1', null, true, Infinity])
    assert.throws(() => validateConfig(config(value)), /keepAlive must be a duration with units, such as "10m", or a number of seconds/);
  for (const value of [0, '0s', '-0m', 0.5, '999ms', '2562048h', '-2562048h', 9.3e15])
    assert.throws(() => validateConfig(config(value)), /keepAlive must be from 1 second to 2562047h, or negative to keep the model loaded/);
  assert.equal(validateConfig(config(false)).jev.channels[0].keepAlive, false, 'false turns the default warm-up off');
  for (const extra of [{ keyEnv: 'KEY' }, { baseUrl: 'https://remote.invalid', keyEnv: 'KEY' }])
    for (const value of ['10m', false])
      assert.throws(() => validateConfig(config(value, extra)), /keepAlive is only allowed on a keyless loopback channel/);
});

/** @param {string | number | false | undefined} [keepAlive] @returns {JevConfig} */
const localJev = (keepAlive = '10m') => ({
  ...JEV,
  channels: [{ name: 'local', baseUrl: 'http://localhost', model: 'nimble', timeoutMs: 20, keepAlive }, ...JEV.channels],
});

test('a keyless loopback channel without keepAlive warms for 10m, and so does a keyless JEV_BASE_URL', async () => {
  let now = 1000;
  const jev = localJev();
  delete jev.channels[0].keepAlive;
  const { client, calls } = scripted({ localhost: [() => reply(200, {})] }, { jev, now: () => now });
  await client.warm();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.host, 'localhost');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { model: 'nimble', keep_alive: '10m' });
  assert.equal(client.health().local.warmup, 'warm');
  now += 597000;
  assert.equal(client.health().local.warmup, 'warm', 'the default residency lasts 10 minutes');
  now += 3000;
  assert.equal(client.health().local.warmup, 'cold', 'the default residency expires after 10 minutes');
  client.close();
  const keyed = scripted({}, { env: { JEV_BASE_URL: 'http://127.0.0.1:11435', JEV_API_KEY: 'k' } });
  await keyed.client.warm();
  assert.equal(keyed.calls.length, 0, 'a JEV_BASE_URL with a key is hosted and never warms');
  keyed.client.close();
  const keyedChannel = {
    ...JEV,
    channels: [{ name: 'local', baseUrl: 'http://localhost', model: 'nimble', keyEnv: 'ONE_KEY', timeoutMs: 20 }],
  };
  const keyedLocal = scripted({}, { jev: keyedChannel });
  await keyedLocal.client.warm();
  assert.equal(keyedLocal.calls.length, 0, 'a keyed loopback channel is hosted and never warms');
  keyedLocal.client.close();
  const env = scripted({ '127.0.0.1:11435': [() => reply(200, {})] }, { env: { JEV_BASE_URL: 'http://127.0.0.1:11435' } });
  await env.client.warm();
  assert.deepEqual(JSON.parse(String(env.calls[0]?.init.body)), { model: 'nimble', keep_alive: '10m' });
  env.client.close();
});

test('expired residency is cold, starts one load and skips decisions until warm again', async (t) => {
  let now = 1000;
  /** @type {(response: Response) => void} */
  let loaded = () => assert.fail('load has not started');
  const { client, calls } = scripted(
    {
      localhost: [
        () => reply(200, {}),
        () =>
          new Promise((resolve) => {
            loaded = resolve;
          }),
        () => good(),
      ],
      'one.invalid': [() => good(), () => good()],
    },
    { jev: localJev('10s'), now: () => now },
  );
  t.after(() => client.close());
  await client.warm();
  assert.equal(client.health().local.warmup, 'warm');
  now += 10000;
  assert.equal(client.health().local.warmup, 'cold');
  assert.equal(calls.length, 1, 'health does not start a load');
  const before = client.health().local.calls;
  const fallback = await client.decide(stateOf('Add a test'));
  assert.ok(fallback.ok && fallback.channel === 'one');
  assert.equal(client.health().local.calls, before, 'expiry skips the decision without waiting for timeout');
  assert.equal(client.health().local.warmup, 'warming');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { model: 'nimble', keep_alive: '10s' });
  const second = await client.decide(stateOf('Add a test'));
  assert.ok(second.ok && second.channel === 'one');
  assert.equal(calls.filter((call) => call.host === 'localhost').length, 2, 'only one reload is in flight');
  loaded(reply(200, {}));
  await client.warm();
  assert.equal(client.health().local.warmup, 'warm');
  const local = await client.decide(stateOf('Add a test'));
  assert.ok(local.ok && local.channel === 'local');
});

test('a successful decision renews residency, including the safety margin for short durations', async (t) => {
  /** @type {Array<[string, number]>} */
  const cases = [
    ['10m', 598000],
    ['1s', 900],
  ];
  for (const [keepAlive, safeMs] of cases) {
    let now = 1000;
    const { client } = scripted({ localhost: [() => reply(200, {}), () => good()] }, { jev: localJev(keepAlive), now: () => now });
    t.after(() => client.close());
    await client.warm();
    now += safeMs - 1;
    const decision = await client.decide(stateOf('Add a test'));
    assert.ok(decision.ok && decision.channel === 'local');
    now += 1;
    assert.equal(client.health().local.warmup, 'warm', 'the original residency expired but the decision renewed it');
    now += safeMs - 1;
    assert.equal(client.health().local.warmup, 'cold', 'the renewed residency expires at the safety margin');
  }
});

test('a decision completing during a residency reload keeps the channel warming', async (t) => {
  let now = 1000;
  /** @type {(response: Response) => void} */
  let decided = () => assert.fail('decision has not started');
  /** @type {(response: Response) => void} */
  let loaded = () => assert.fail('load has not started');
  const { client, calls } = scripted(
    {
      localhost: [
        () => reply(200, {}),
        () =>
          new Promise((resolve) => {
            decided = resolve;
          }),
        () =>
          new Promise((resolve) => {
            loaded = resolve;
          }),
      ],
      'one.invalid': [() => good()],
    },
    { jev: localJev('10s'), now: () => now },
  );
  t.after(() => client.close());
  await client.warm();
  const decision = client.decide(stateOf('Add a test'));
  now += 10000;
  const fallback = await client.decide(stateOf('Add a test'));
  assert.ok(fallback.ok && fallback.channel === 'one');
  decided(good());
  assert.ok((await decision).ok);
  assert.equal(client.health().local.warmup, 'warming', 'a successful decision does not hide the pending load');
  assert.equal(calls.length, 4);
  loaded(reply(200, {}));
  await client.warm();
  assert.equal(client.health().local.warmup, 'warm');
});

test('negative keepAlive never expires after a warm-up or a successful decision', async (t) => {
  for (const keepAlive of [-1, '-1m']) {
    let now = 1000;
    const { client, calls } = scripted({ localhost: [() => reply(200, {}), () => good()] }, { jev: localJev(keepAlive), now: () => now });
    t.after(() => client.close());
    await client.warm();
    now += 365 * 24 * 3600000;
    assert.equal(client.health().local.warmup, 'warm');
    assert.ok((await client.decide(stateOf('Add a test'))).ok);
    now += 365 * 24 * 3600000;
    assert.equal(client.health().local.warmup, 'warm');
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(String(calls[1].init.body)).keep_alive, keepAlive);
  }
});

test('decisions establish residency without warm-up, and expired live diagnostics never start loads', async (t) => {
  let now = 1000;
  const { client, calls } = scripted({ localhost: [() => good(), () => good()] }, { jev: localJev('10s'), now: () => now });
  t.after(() => client.close());
  assert.equal(client.health().local.warmup, 'idle');
  assert.ok((await client.decide(stateOf('Add a test'))).ok);
  assert.equal(client.health().local.warmup, 'warm');
  now += 10000;
  assert.equal(client.health().local.warmup, 'cold');
  assert.ok((await client.decide(stateOf('Add a test'), { warmOnTimeout: false })).ok);
  assert.equal(client.health().local.warmup, 'warm');
  assert.equal(calls.length, 2);
  for (const call of calls) assert.ok(JSON.parse(String(call.init.body)).state, 'only decision calls were sent');
});

test('warm is explicit, single-flight, skips loading channels, and keeps hosted payloads unchanged', async () => {
  /** @type {(response: Response) => void} */
  let loaded = () => assert.fail('load request has not started');
  const { client, calls } = scripted(
    {
      localhost: [
        () =>
          new Promise((resolve) => {
            loaded = resolve;
          }),
        () => good(),
      ],
      'one.invalid': [() => good()],
    },
    { jev: localJev() },
  );
  assert.equal(calls.length, 0, 'the constructor does not load models');
  const warming = client.warm();
  const again = client.warm();
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { model: 'nimble', keep_alive: '10m' });
  assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' });
  assert.equal(client.health().local.warmup, 'warming');
  const fallback = await client.decide(stateOf('Add a test'));
  assert.ok(fallback.ok && fallback.channel === 'one');
  assert.equal(
    String(calls[1].init.body),
    JSON.stringify({ model: JEV.channels[0].model, state: stateOf('Add a test'), questions: buildQuestions(JEV) }),
  );
  loaded(reply(200, { done_reason: 'load' }));
  await Promise.all([warming, again]);
  assert.equal(client.health().local.warmup, 'warm');
  assert.equal(client.health().local.open, false);
  assert.ok((await client.decide(stateOf('Add a test'))).ok);
  assert.equal(JSON.parse(String(calls[2].init.body)).keep_alive, '10m');
  client.close();
});

test('a timeout opens the breaker and warms independently of the caller', async () => {
  const { client, calls } = scripted({ localhost: [hang, hang], 'one.invalid': [() => good(), () => good()] }, { jev: localJev() });
  const caller = new AbortController();
  const first = await client.decide(stateOf('Add a test'), { signal: caller.signal });
  assert.ok(first.ok && first.channel === 'one');
  assert.equal(client.health().local.open, true);
  assert.equal(client.health().local.warmup, 'warming');
  caller.abort();
  assert.equal(calls[1].init.signal?.aborted, false, 'warm-up survives request abort');
  const second = await client.decide(stateOf('Add a test'));
  assert.ok(second.ok && second.channel === 'one');
  assert.equal(calls.filter((c) => c.host === 'localhost').length, 2);
  const pending = client.warm();
  client.close();
  await pending;
  assert.equal(calls[1].init.signal?.aborted, true);
  await client.warm();
  assert.equal(calls.length, 4, 'close prevents further warm-ups');
});

test('after a timeout, only a load slower than timeoutMs clears the breaker', async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve(reply(200, { done_reason: 'load' })), 40));
  /** @type {[(init: RequestInit) => Promise<Response> | Response, boolean][]} */
  const cases = [
    [slow, false],
    [() => reply(200, { done_reason: 'load' }), true],
  ];
  for (const [load, open] of cases) {
    const jev = localJev();
    jev.channels = jev.channels.slice(0, 1);
    const { client } = scripted({ localhost: [hang, load] }, { jev });
    const result = await client.decide(stateOf('Add a test'));
    assert.ok(!result.ok && result.error.includes('local: timeout'));
    await client.warm();
    assert.equal(client.health().local.warmup, 'warm');
    assert.equal(client.health().local.open, open);
    client.close();
  }
});

test('after a failed load, decisions keep the channel answering and expiry starts no new load', async (t) => {
  let now = 1000;
  const { client, calls } = scripted(
    { localhost: [() => reply(404, { error: 'not found' }), () => good(), () => good()] },
    { jev: localJev(), now: () => now },
  );
  t.after(() => client.close());
  await client.warm();
  assert.equal(client.health().local.warmup, 'failed');
  now += 30000;
  const first = await client.decide(stateOf('Add a test'));
  assert.ok(first.ok && first.channel === 'local');
  assert.equal(client.health().local.warmup, 'failed', 'a decision does not prove the server loads models');
  now += 600000;
  const later = await client.decide(stateOf('Add a test'));
  assert.ok(later.ok && later.channel === 'local', 'expiry does not send the channel back to a failing load');
  assert.equal(calls.filter((call) => call.host === 'localhost').length, 3);
});

test('a failed reload after a warm-up clears residency, so the next decision answers and starts no load', async (t) => {
  let now = 1000;
  const { client, calls } = scripted(
    { localhost: [() => reply(200, {}), () => reply(404, { error: 'not found' }), () => good()] },
    { jev: localJev(), now: () => now },
  );
  t.after(() => client.close());
  await client.warm();
  assert.equal(client.health().local.warmup, 'warm');
  now += 600000;
  await client.warm();
  assert.equal(client.health().local.warmup, 'failed');
  now += 31000;
  const answer = await client.decide(stateOf('Add a test'));
  assert.ok(answer.ok && answer.channel === 'local', 'an expired residency from before the failure does not skip the channel');
  assert.equal(calls.filter((call) => call.host === 'localhost').length, 3);
});

test('failed warm-ups open the breaker and a later successful warm-up clears it', async () => {
  for (const failure of [
    () => reply(503, { error: 'load failed' }),
    () => {
      throw new TypeError('offline');
    },
    () => {
      throw new DOMException('load timeout', 'TimeoutError');
    },
  ]) {
    const { client } = scripted({ localhost: [failure, () => reply(200, { done_reason: 'load' }), () => good()] }, { jev: localJev() });
    await client.warm();
    assert.equal(client.health().local.warmup, 'failed');
    assert.equal(client.health().local.open, true);
    const skipped = await client.decide(stateOf('Add a test'));
    assert.ok(!skipped.ok && skipped.error.includes('local: skipped (failing)'));
    await client.warm();
    assert.equal(client.health().local.open, false);
    assert.equal(client.health().local.lastError, null);
    assert.ok((await client.decide(stateOf('Add a test'))).ok);
    client.close();
  }
});

test('warm ignores hosted channels and local channels with keepAlive false', async () => {
  const jev = localJev(false);
  const { client, calls } = scripted({ localhost: [() => good()] }, { jev });
  await client.warm();
  assert.equal(calls.length, 0);
  assert.ok((await client.decide(stateOf('Add a test'))).ok);
  assert.equal(JSON.parse(String(calls[0].init.body)).keep_alive, undefined);
  client.close();
});

test('warming alone falls through immediately and live diagnostics never trigger recovery loads', async () => {
  const jev = localJev();
  jev.channels = jev.channels.slice(0, 1);
  const { client, calls } = scripted({ localhost: [hang] }, { jev });
  const pending = client.warm();
  const result = await client.decide(stateOf('Add a test'));
  assert.ok(!result.ok && result.error === 'local: warming');
  assert.equal(calls.length, 1);
  client.close();
  await pending;
  const diagnostic = scripted({ localhost: [hang] }, { jev });
  await diagnostic.client.decide(stateOf('Add a test'), { warmOnTimeout: false });
  assert.equal(diagnostic.calls.length, 1);
  assert.equal(diagnostic.client.health().local.open, true);
  diagnostic.client.close();
});

test('a warm-up has its own long timeout and a closed client sends nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, calls } = scripted(
    {
      localhost: [
        (init) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          }),
      ],
    },
    { jev: localJev() },
  );
  const pending = client.warm();
  t.mock.timers.tick(299999);
  assert.equal(client.health().local.warmup, 'warming');
  assert.equal(calls[0].init.signal?.aborted, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(client.health().local.warmup, 'failed');
  assert.equal(client.health().local.open, true);
  client.close();
  const stopped = scripted({}, { jev: localJev() });
  stopped.client.close();
  await stopped.client.warm();
  assert.equal(stopped.calls.length, 0);
});

test('a synchronous fetch failure releases the warm-up flight for the next load', async (t) => {
  let calls = 0;
  const client = new JevClient(
    localJev(),
    {},
    {
      fetchImpl: () => {
        calls += 1;
        if (calls === 1) throw new TypeError('offline');
        return Promise.resolve(reply(200, {}));
      },
    },
  );
  t.after(() => client.close());
  await client.warm();
  assert.equal(client.health().local.warmup, 'failed');
  await client.warm();
  assert.equal(client.health().local.warmup, 'warm');
  assert.equal(calls, 2);
});

test('without a fetchImpl the warm-up loads a loopback model with a direct request', async (t) => {
  const ollama = await mockServer((_call, res) => json(res, 200, {}));
  const jev = localJev();
  const client = new JevClient({ ...jev, channels: [{ ...jev.channels[0], baseUrl: ollama.url }] }, {});
  t.after(async () => {
    client.close();
    await ollama.close();
  });
  await client.warm();
  assert.deepEqual(
    ollama.calls.map((call) => call.url),
    ['/api/generate'],
  );
  assert.equal(ollama.calls[0]?.body.keep_alive, '10m');
  assert.equal(client.health().local.warmup, 'warm');
});

test('a channel threshold overrides the policy for that model only', () => {
  const thresholds = { accept: { fast: 0.99 }, sensitiveOverride: 0.95, claimGuard: 0.9 };
  const tuned = policyFor(cfg.policy, thresholds);
  assert.equal(tuned.accept.fast, 0.99);
  assert.equal(tuned.accept.balanced, cfg.policy.accept.balanced, 'tiers the channel does not name stay on the policy');
  assert.equal(tuned.sensitiveOverride, 0.95);
  assert.equal(tuned.claimGuard, 0.9);
  assert.equal(policyFor(cfg.policy, undefined), cfg.policy);
  const probabilities = { mechanical: 0.9, routine: 0.1 };
  assert.equal(
    applyPolicy({ answer: { probabilities }, tiers: TIERS, options: cfg.jev.options, policy: cfg.policy, reference: 'balanced' }).tier,
    'fast',
  );
  assert.equal(
    applyPolicy({ answer: { probabilities }, tiers: TIERS, options: cfg.jev.options, policy: tuned, reference: 'balanced' }).tier,
    'balanced',
    "0.90 is under this model's fast bar, so the policy escalates",
  );
  assert.equal(
    applyPolicy({ answer: { probabilities, sensitive: 0.8 }, tiers: TIERS, options: cfg.jev.options, policy: tuned, reference: 'balanced' })
      .tier,
    'balanced',
    "Jev's sensitive bar is not this model's",
  );
});

test('an unsupported question type fails open, the same way a failed Jev call does', async () => {
  const questions = buildQuestions(cfg.jev);
  const hosted = prepareQuestions(questions, false);
  assert.equal(hosted.ok && hosted.questions, questions, 'a hosted channel keeps the structured criteria');
  const local = prepareQuestions(questions, true);
  assert.ok(local.ok);
  assert.equal(typeof (local.ok && local.questions.tier.criteria.mechanical), 'string');
  const rejected = prepareQuestions(
    /** @type {import('../src/types.js').JevQuestions} */ ({ ...questions, rank: { type: 'rank', instructions: 'Order them.' } }),
    true,
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? '' : rejected.error, /unsupported question type: rank \(rank\)/);
  const localChannel = {
    ...JEV,
    channels: [{ name: 'ollama', baseUrl: 'http://127.0.0.1:11435', model: 'nimble', timeoutMs: 500 }],
  };
  const { client, calls } = scripted(
    { '127.0.0.1:11435': [() => reply(400, { error: 'question "tier": type must be choice, noul, or score' })] },
    { jev: localChannel, env: {} },
  );
  const answer = await client.decide(stateOf('Add a test'));
  assert.equal(answer.ok, false);
  assert.ok(!answer.ok && answer.error.includes('type must be choice, noul, or score'));
  assert.equal(calls.length, 1, 'a 400 is not retried; the next channel, or the fallback, decides');
  assert.equal(client.health().ollama.open, false);
});

/**
 * @param {string} tier
 * @returns {SessionEntry}
 */
const entry = (tier) => ({ tier, trustedOnly: false, provisional: false, attempts: 0, freshNext: false });

test('sessions: the state file survives a restart, is compacted on load, and drops expired sessions and a torn last line', () => {
  const file = `${mkdtempSync(`${tmpdir()}/jev-sessions-`)}/nested/sessions.jsonl`;
  const one = new SessionStore({ file });
  one.set('alpha', entry('fast'));
  one.set('beta', entry('balanced'));
  one.set('alpha', entry('frontier'));
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3, 'every change is appended');
  const old = { k: hashKey('old'), ...entry('fast'), updated: Date.now() - 8 * 24 * 3600 * 1000 };
  appendFileSync(file, `${JSON.stringify(old)}\n{"k":"torn`);
  /** @type {unknown[]} */
  const errors = [];
  const two = new SessionStore({ file, onError: (err) => errors.push(err) });
  assert.deepEqual(errors, []);
  assert.equal(two.size, 2, 'the expired session is dropped');
  assert.equal(two.get('alpha')?.tier, 'frontier', 'the last line for a session wins');
  assert.equal(two.get('beta')?.tier, 'balanced');
  assert.equal(two.get('old'), undefined);
  const beta = two.get('beta');
  assert.equal(beta?.lastSeen, beta?.updated, 'a loaded session was last seen when it was stored');
  const text = readFileSync(file, 'utf8');
  assert.equal(text.trim().split('\n').length, 2, 'rewritten with one line per live session');
  assert.ok(!text.includes('lastSeen') && !/alpha|beta/.test(text), 'only hashed keys, and no activity times');
});

test('sessions: the least recently used session goes first, in memory and when the file is loaded', () => {
  const store = new SessionStore({ max: 2 });
  store.set('a', entry('fast'));
  store.set('b', entry('fast'));
  assert.ok(store.get('a'), 'reading a makes it the most recently used');
  store.set('c', entry('fast'));
  assert.equal(store.get('b'), undefined);
  assert.ok(store.get('a') && store.get('c'));
  store.touch('a');
  store.touch('missing');
  assert.ok(store.get('a')?.lastSeen);
  const file = `${mkdtempSync(`${tmpdir()}/jev-sessions-`)}/sessions.jsonl`;
  const writer = new SessionStore({ file });
  for (const key of ['x', 'y', 'z']) writer.set(key, entry('balanced'));
  const reader = new SessionStore({ file, max: 2 });
  assert.equal(reader.get('x'), undefined, 'the oldest line goes first');
  assert.ok(reader.get('y') && reader.get('z'));
});

test('sessions: file errors go to onError, and the store keeps working in memory', () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-sessions-`);
  mkdirSync(`${dir}/sessions.jsonl`); // a directory where the file should be
  /** @type {unknown[]} */
  const errors = [];
  const store = new SessionStore({ file: `${dir}/sessions.jsonl`, onError: (err) => errors.push(err) });
  store.set('a', entry('fast'));
  assert.equal(errors.length, 2, 'the load and the append both failed');
  assert.equal(store.get('a')?.tier, 'fast');
  assert.doesNotThrow(() => new SessionStore({ file: `${dir}/sessions.jsonl` }).set('b', entry('fast')), 'without onError too');
});

test('the usage tap reads JSON bodies and skips junk; costOf falls back to undated prices', () => {
  const anthropicJson = new UsageTap('application/json');
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 10 },
  });
  for (const part of [body.slice(0, 20), body.slice(20)]) anthropicJson.push(Buffer.from(part));
  const usage = anthropicJson.result();
  assert.deepEqual(usage, { input: 100, cacheRead: 1000, cacheWrite: 100, output: 10 });
  assert.equal(anthropicJson.model, 'claude-haiku-4-5-20251001');
  assert.equal(costOf('claude-haiku-4-5-20251001', usage, cfg.prices), 0.000375, 'priced as claude-haiku-4-5');
  const responsesJson = new UsageTap('application/json; charset=utf-8');
  responsesJson.push(
    Buffer.from(
      JSON.stringify({
        model: 'gpt-6-sol',
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 20 },
      }),
    ),
  );
  assert.deepEqual(responsesJson.result(), { input: 400, cacheRead: 600, cacheWrite: 0, output: 20 });
  const cut = new UsageTap('application/json');
  cut.push(Buffer.from('{"usage":{"input_tok'));
  assert.equal(cut.result(), undefined, 'a cut-off body has no usage');
  const noUsage = new UsageTap();
  noUsage.push(Buffer.from('{"id":"x"}'));
  assert.equal(noUsage.result(), undefined);
  const junk = new UsageTap('text/event-stream');
  junk.push(Buffer.from('data: [DONE]\n\ndata: {oops\n\ndata:\n\nevent: ping\n\n'));
  junk.push(Buffer.from('data: {"type":"response.incomplete","response":{"model":"m","usage":{"input_tokens":5,"output_tokens":1}}}\n\n'));
  assert.deepEqual(junk.result(), { input: 5, cacheRead: 0, cacheWrite: 0, output: 1 });
  assert.equal(junk.model, 'm');
  const flat = { input: 1e6, cacheRead: 0, cacheWrite: 1e6, output: 0 };
  assert.equal(costOf('glm-5.3-flash', flat, cfg.prices), 0.3, 'a missing cacheWrite price is the input price');
  assert.equal(costOf('', usage, cfg.prices), undefined);
  assert.equal(costOf('glm-5.3-flash', undefined, cfg.prices), undefined);
});

test('report counts unpriced responses and uses the cost as baseline when there is none', () => {
  const r = report(
    [
      { event: 'done', session: 's', model: 'mystery-model', usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 1 } },
      { event: 'done', session: 's', model: 'glm-5.3-flash', cost_usd: 0.001 },
      { event: 'done', session: 's', status: 499, client_aborted: true },
      { event: 'warning', message: 'no Jev key' },
    ].map((e) => JSON.stringify(e)),
  );
  assert.equal(r.unpriced_responses, 1);
  assert.equal(r.baseline_usd, 0.001);
  assert.equal(r.saved_usd, 0);
  assert.deepEqual(r.models['mystery-model'], { requests: 1, cost_usd: 0, input: 5, cache_read: 0, output: 1 });
  assert.deepEqual(r.jev, { calls: 0, fallbacks: 0, fallback_rate: 0, p50_ms: null, p95_ms: null, cost_usd: 0 });
});

test('config validation reports malformed Jev channels instead of crashing', () => {
  for (const channels of ['typesafe', { name: 'typesafe' }, [null], [42]]) {
    const cfg = structuredClone(shipped);
    cfg.jev.channels = channels;
    assert.throws(() => validateConfig(cfg), /jev\.channels( must be an array|\[0\] must be an object)/, JSON.stringify(channels));
  }
});

test('the log file rotates to <file>.1 before a line would take it past logMaxBytes, and never loses a line', () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-log-`);
  const file = `${dir}/router.log`;
  const line = (/** @type {number} */ n) => `${JSON.stringify({ event: 'done', req: n, pad: 'x'.repeat(40) })}\n`;
  const size = line(1).length;
  const rotations = [1, 2, 3, 4, 5, 6, 7].map((n) => appendLogLine(file, line(n), 3 * size));
  assert.deepEqual(rotations, [false, false, false, true, false, false, true], 'three lines fit, the fourth starts a new file');
  assert.equal(readFileSync(`${file}.1`, 'utf8'), [4, 5, 6].map(line).join(''), 'one old file is kept, the one before it goes');
  assert.equal(readFileSync(file, 'utf8'), line(7));
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const off = `${dir}/off.log`;
  for (let n = 0; n < 5; n += 1) assert.equal(appendLogLine(off, line(n), 0), false, '0 never rotates');
  assert.equal(readFileSync(off, 'utf8').length, 5 * size);
  const big = `${dir}/big.log`;
  assert.equal(appendLogLine(big, line(1), 10), false, 'a line longer than the limit still goes into an empty file');
  assert.equal(appendLogLine(big, line(2), 10), true);
  assert.equal(readFileSync(big, 'utf8'), line(2));

  const stuck = `${dir}/stuck.log`;
  writeFileSync(stuck, line(1));
  mkdirSync(`${stuck}.1/busy`, { recursive: true }); // a directory that can't be replaced
  assert.equal(appendLogLine(stuck, line(2), size), false, 'a rotation that fails keeps the line in the old file');
  assert.equal(readFileSync(stuck, 'utf8'), line(1) + line(2));
  const target = `${dir}/target.log`;
  writeFileSync(target, line(1));
  symlinkSync(target, `${dir}/link.log`);
  assert.equal(appendLogLine(`${dir}/link.log`, line(2), size), false, 'a symbolic link is not rotated');
  assert.ok(!existsSync(`${dir}/link.log.1`));
  assert.throws(() => appendLogLine(`${dir}/no-such-dir/router.log`, line(1), size), /ENOENT/, 'a line that cannot be written throws');
});

test('config: logMaxBytes defaults to 50 MiB and takes 0 to never rotate; logFile must be a path', () => {
  assert.equal(cfg.logMaxBytes, 50 * 1024 * 1024);
  const { logMaxBytes, ...unset } = shipped;
  assert.equal(validateConfig({ ...unset, stateFile: null }).logMaxBytes, 52428800, 'the default without the key');
  assert.equal(validateConfig({ ...shipped, stateFile: null, logMaxBytes: 0 }).logMaxBytes, 0);
  assert.equal(validateConfig({ ...shipped, stateFile: null, logMaxBytes: null }).logMaxBytes, 52428800, 'null is the default');
  for (const bad of [-1, 1.5, '50MB'])
    assert.throws(
      () => validateConfig({ ...shipped, stateFile: null, logMaxBytes: bad }),
      /logMaxBytes must be a whole number of bytes/,
      String(bad),
    );
  for (const bad of [2, '', true])
    assert.throws(() => validateConfig({ ...shipped, stateFile: null, logFile: bad }), /logFile must be a file path or null/, String(bad));
  assert.equal(validateConfig({ ...shipped, stateFile: null, logFile: null }).logFile, null);
});

test('sessions: the state file is rewritten while the router runs, so it stays near one line per session', () => {
  const file = `${mkdtempSync(`${tmpdir()}/jev-sessions-`)}/sessions.jsonl`;
  const store = new SessionStore({ file });
  const lines = () => readFileSync(file, 'utf8').trim().split('\n').length;
  for (let i = 0; i < 1000; i += 1) store.set(i % 2 ? 'odd' : 'even', entry(i % 3 ? 'fast' : 'frontier'));
  assert.equal(lines(), 1000, 'every change is appended');
  store.set('even', entry('balanced'));
  assert.equal(lines(), 2, 'one change more, and the file holds one line per session');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!existsSync(`${file}.tmp`));
  const reloaded = new SessionStore({ file });
  assert.equal(reloaded.get('even')?.tier, 'balanced');
  assert.equal(reloaded.get('odd')?.tier, 'frontier');
});

test('the usage tap drops an SSE line that never ends instead of holding it', () => {
  const tap = new UsageTap('text/event-stream');
  tap.push(Buffer.from(`data: ${'x'.repeat(9 * 1024 * 1024)}`));
  assert.equal(tap.pending, '', 'more than 8 MiB without a newline is let go');
  tap.push(Buffer.from('xx\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'));
  assert.deepEqual(tap.result(), { input: 0, cacheRead: 0, cacheWrite: 0, output: 5 }, 'and the lines after it are read');
});

test('Jev client: a long error body is cut to 200 characters, and an odd one does not throw', async () => {
  const { client } = scripted({
    'one.invalid': [() => reply(422, { detail: 'y'.repeat(10000) })],
    'two.invalid': [() => reply(500, { error: { message: 42 } }), () => reply(500, { error: { message: 42 } })],
  });
  const answer = await client.decide(stateOf('Add a test'));
  assert.ok(!answer.ok);
  assert.equal(client.health().one.lastError, `HTTP 422 ${'y'.repeat(200)}`);
  assert.equal(client.health().two.lastError, 'HTTP 500 42');
});

test('sessions: a rewrite that fails, as on a full or read-only disk, is reported and changes nothing', {
  skip: process.getuid?.() === 0 && 'root ignores file modes',
}, () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-sessions-`);
  const file = `${dir}/sessions.jsonl`;
  /** @type {unknown[]} */
  const errors = [];
  const store = new SessionStore({ file, onError: (err) => errors.push(err) });
  store.set('kept', entry('frontier'));
  chmodSync(dir, 0o500); // the file can still be appended to, but no new file can be made next to it
  try {
    for (let i = 0; i < 1000; i += 1) store.set('busy', entry('fast'));
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(errors.length, 1, 'the failed rewrite is reported once');
  assert.match(String(/** @type {Error} */ (errors[0]).message), /EACCES/);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1001, 'the file is left as it was, every line in it');
  assert.equal(store.get('kept')?.tier, 'frontier', 'and the store goes on');
  assert.equal(new SessionStore({ file }).get('busy')?.tier, 'fast');
});

// Setup's building blocks: the env file writer, typed secrets, questions, install specs, the
// service files and Claude Code's settings.

test('env file: a value Node would misread goes in quotes, and every value reads back the same', () => {
  const values = [
    'plain-key_123',
    'a#b',
    ' lead',
    'trail ',
    'in side',
    "'quoted'",
    '"quoted"',
    '`quoted`',
    "it's",
    'say "hi"',
    'a\'b"c',
    '$HOME',
    fake('$', '{HOME}'),
    'a=b',
    'back\\nslash',
    "x'\\ny",
    'two\nlines',
    'tab\tinside',
    '',
    'ümlaut',
  ];
  for (const value of values) {
    const line = `KEY=${quoteEnvValue(value)}\n`;
    assert.equal(parseEnv(line).KEY, value, `${JSON.stringify(value)} as ${JSON.stringify(line)}`);
  }
  assert.equal(quoteEnvValue('plain-key_123'), 'plain-key_123', 'a plain key stays bare');
  assert.equal(quoteEnvValue('a#b'), "'a#b'");
  assert.equal(quoteEnvValue("it's #1"), '"it\'s #1"');
  assert.throws(() => quoteEnvValue('a\'b"c`d#'), /all three kinds of quotes/);
  assert.throws(() => quoteEnvValue('a\rb'), /carriage return/);
});

test('env file: setting keys replaces their lines in place and keeps every other line', () => {
  const text = [
    '# my keys',
    'TYPESAFE_API_KEY=old',
    '',
    'export OLLAMA_API_KEY="first',
    'line"',
    'OTHER=1 # a comment',
    'TYPESAFE_API_KEY=later',
    'broken line without equals',
    "QUOTE='never closed",
    '',
  ].join('\n');
  const out = setEnvValues(text, { TYPESAFE_API_KEY: 'new', OLLAMA_API_KEY: 'o#k', NEW_KEY: 'n' });
  assert.equal(
    out,
    [
      '# my keys',
      'TYPESAFE_API_KEY=new',
      '',
      "export OLLAMA_API_KEY='o#k'",
      'OTHER=1 # a comment',
      'broken line without equals',
      "QUOTE='never closed",
      'NEW_KEY=n',
      '',
    ].join('\n'),
  );
  assert.deepEqual(parseEnv(out), { TYPESAFE_API_KEY: 'new', OLLAMA_API_KEY: 'o#k', OTHER: '1', QUOTE: "'never closed", NEW_KEY: 'n' });
  assert.equal(setEnvValues('', { A: '1' }), 'A=1\n');
  assert.equal(setEnvValues('A=1', { B: '2' }), 'A=1\nB=2\n', 'a last line without a line break keeps its line');
  assert.equal(setEnvValues('A=1\r\nB=2\r\n', { A: '3' }), 'A=3\r\nB=2\r\n', 'Windows line breaks stay');
});

test('typed secrets: Enter, Backspace, Ctrl-U, Ctrl-C, Ctrl-D, pastes and escape sequences', () => {
  assert.deepEqual(typeKeys('', 'abc\r'), { value: 'abc', rest: '', done: true });
  assert.deepEqual(typeKeys('', 'ab\u007fc\bd\n'), { value: 'ad', rest: '', done: true }, 'both backspaces');
  assert.deepEqual(typeKeys('', 'pasted-key\r\nnext answer\n'), { value: 'pasted-key', rest: 'next answer\n', done: true });
  assert.deepEqual(typeKeys('ab', 'c'), { value: 'abc', rest: '', done: false }, 'a key at a time');
  assert.deepEqual(typeKeys('secret', '\u0015new\r'), { value: 'new', rest: '', done: true }, 'Ctrl-U clears');
  assert.deepEqual(typeKeys('x', '\u0003'), { value: '', rest: '', done: true, abort: 130 });
  assert.deepEqual(typeKeys('', '\u0004'), { value: '', rest: '', done: true, abort: 1 });
  assert.deepEqual(typeKeys('key', '\u0004more'), { value: 'key', rest: 'more', done: true }, 'Ctrl-D ends a line that has text');
  assert.deepEqual(typeKeys('', '\u001b[A\u001b[200~k\u001b[201~ey\u001bOP\u001b\u0001\t\r'), { value: 'key', rest: '', done: true });
  assert.deepEqual(typeKeys('é', '\u007f'), { value: '', rest: '', done: false }, 'Backspace removes a whole character');
});

/**
 * A stand-in for stdin: a pipe, or a terminal whose raw mode is recorded.
 * @param {boolean} [terminal]
 */
function fakeInput(terminal = false) {
  const input = new PassThrough();
  /** @type {boolean[]} */
  const raw = [];
  Object.assign(input, { isTTY: terminal, setRawMode: (/** @type {boolean} */ on) => raw.push(on) });
  return { input, raw, stdin: /** @type {NodeJS.ReadStream} */ (/** @type {unknown} */ (input)) };
}

/** Collects what a Prompter prints. */
function fakeOutput() {
  const output = new PassThrough();
  const text = { value: '' };
  output.on('data', (chunk) => {
    text.value += chunk;
  });
  return { output, text };
}

test('questions: one reader serves every question, so piped answers that arrive together all count', async () => {
  const { input, stdin } = fakeInput();
  const { output, text } = fakeOutput();
  const prompter = new Prompter(stdin, output);
  input.write('2\nsecret-value\n\nmaybe\nN\n');
  assert.equal(await prompter.ask('Choose: '), '2');
  assert.equal(await prompter.secret('Key: '), 'secret-value');
  assert.equal(await prompter.confirm('Go?', true), true, 'Enter takes the default');
  assert.equal(await prompter.confirm('Again?', true), false, 'after a wrong answer it asks again');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(text.value, 'Choose: 2\nKey: \nGo? [Y/n] \nAgain? [Y/n] maybe\nPlease answer y or n.\nAgain? [Y/n] N\n');
  assert.ok(!text.value.includes('secret-value'), 'a secret is never printed');
  input.end('last answer without a line break');
  assert.equal(await prompter.ask('More? '), 'last answer without a line break');
  await assert.rejects(prompter.ask('And? '), (/** @type {PromptAbort} */ err) => err instanceof PromptAbort && err.exitCode === 1);
  prompter.close();
});

test('questions: Ctrl-C outside raw mode interrupts the question being asked', async () => {
  const { stdin } = fakeInput();
  const prompter = new Prompter(stdin, fakeOutput().output);
  const waiting = prompter.ask('Choose: ');
  prompter.interrupt();
  await assert.rejects(waiting, (/** @type {PromptAbort} */ err) => err.exitCode === 130);
  await assert.rejects(prompter.confirm('Again?', true), (/** @type {PromptAbort} */ err) => err.exitCode === 130);
  prompter.close();
});

test('questions: on a terminal a secret is typed in raw mode without an echo, and what follows Enter is kept', async () => {
  const { input, raw, stdin } = fakeInput(true);
  const { output, text } = fakeOutput();
  const prompter = new Prompter(stdin, output);
  assert.equal(prompter.terminal, true);
  const typed = prompter.secret('Key: ');
  input.write('ab');
  input.write('\u007fc\rleft over\n');
  assert.equal(await typed, 'ac');
  assert.deepEqual(raw, [true, false], 'raw mode is on only while the secret is typed');
  assert.equal(await prompter.ask('Next: '), 'left over');
  const interrupted = prompter.secret('Key: ');
  input.write('x\u0003');
  await assert.rejects(interrupted, (/** @type {PromptAbort} */ err) => err.exitCode === 130);
  const ended = prompter.secret('Key: ');
  input.write('\u0004');
  await assert.rejects(ended, (/** @type {PromptAbort} */ err) => err.exitCode === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(text.value, 'Key: \nNext: Key: Key: ', 'no echo of what was typed; a terminal echoes answers itself');
  assert.deepEqual(raw, [true, false, true, false, true, false]);
  prompter.close();
});

test('install: npx runs are recognized by where the package really is, and npm gets the spec npx recorded', () => {
  const root = mkdtempSync(`${tmpdir()}/jev-npx-`);
  const npx = `${root}/cache/_npx/1a2b3c`;
  const bin = `${npx}/node_modules/@ediri/jev-router/bin`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/jev-router.mjs`, '');
  mkdirSync(`${npx}/node_modules/.bin`);
  symlinkSync(`${bin}/jev-router.mjs`, `${npx}/node_modules/.bin/jev-router`);
  assert.equal(npxDirOf(`${npx}/node_modules/.bin/jev-router`), npx);
  assert.equal(npxDirOf(`${root}/elsewhere/jev-router`), undefined);

  assert.deepEqual(installSpec(undefined, npx, '1.5.0'), { spec: '@ediri/jev-router@1.5.0', registry: true }, "when it can't tell");
  assert.deepEqual(installSpec('^1.5.0', npx, '1.5.0'), { spec: '@ediri/jev-router@1.5.0', registry: true });
  assert.deepEqual(installSpec('latest', npx, '1.5.0'), { spec: '@ediri/jev-router@1.5.0', registry: true });
  for (const git of [
    'github:dirien/jev-router',
    'github:dirien/jev-router#semver:^1',
    'git+https://github.com/dirien/jev-router.git',
    'dirien/jev-router#v1.5.0',
  ])
    assert.deepEqual(installSpec(git, npx, '1.5.0'), { spec: git, registry: false }, git);
  assert.deepEqual(installSpec('file:../../../ediri-jev-router-1.5.0.tgz', npx, '1.5.0'), {
    spec: `${root}/ediri-jev-router-1.5.0.tgz`,
    registry: false,
  });

  writeFileSync(`${npx}/package.json`, JSON.stringify({ dependencies: { '@ediri/jev-router': 'github:dirien/jev-router#semver:^1' } }));
  assert.deepEqual(origin('1.5.0', `${bin}/jev-router.mjs`), {
    npx,
    spec: 'github:dirien/jev-router#semver:^1',
    npxCommand: "npx 'github:dirien/jev-router#semver:^1'",
  });
  writeFileSync(`${npx}/package.json`, JSON.stringify({ dependencies: { '@ediri/jev-router': '*' } }));
  assert.deepEqual(origin('1.5.0', `${bin}/jev-router.mjs`), { npx, spec: '@ediri/jev-router@1.5.0', npxCommand: 'npx @ediri/jev-router' });
  writeFileSync(`${npx}/package.json`, '{ not json');
  assert.equal(origin('1.5.0', `${bin}/jev-router.mjs`).spec, '@ediri/jev-router@1.5.0');
  assert.deepEqual(origin('1.5.0', `${root}/clone/bin/jev-router.mjs`), { spec: '@ediri/jev-router@1.5.0' }, 'not npx');
});

test('the package name and version in the code match package.json, and a jev-router command says its version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PACKAGE, pkg.name);
  assert.equal(VERSION, pkg.version);
  assert.notEqual(LEGACY_PACKAGE, pkg.name);
  const bin = new URL('../bin/jev-router.mjs', import.meta.url).pathname;
  assert.equal(commandVersion(bin, process.env), pkg.version);
  assert.equal(commandVersion(`${tmpdir()}/no-such-jev-router`, process.env), '');
});

/**
 * A template as the manual route installs it: the sed commands in its header fill in the home and
 * PATH placeholders, and systemd expands %h itself. The header comment differs from setup's, so it goes.
 * @param {string} text
 * @param {string} home
 * @param {string} path
 */
const manually = (text, home, path) =>
  text
    .replaceAll('@HOME@', home)
    .replaceAll('@PATH@', path)
    .replaceAll('%h', home)
    .replace(/<!--[\s\S]*?-->\n/, '')
    .replace(/^(#.*\n)+\n?/, '');

test('service: setup installs the same launchd agent and systemd unit as the manual route in examples/service', () => {
  const home = homedir();
  const path = '/opt/node/bin:/usr/bin:/bin';
  const args = [
    '/usr/bin/env',
    'jev-router',
    'serve',
    '--ui',
    '4100',
    '--config',
    `${home}/.config/jev-router/config.json`,
    '--env-file',
    `${home}/.config/jev-router/env`,
    '--log-file',
    `${home}/.local/state/jev-router/router.log`,
  ];
  for (const [manager, template] of /** @type {const} */ ([
    ['launchd', '../examples/service/launchd/io.github.dirien.jev-router.plist'],
    ['systemd', '../examples/service/systemd/jev-router.service'],
  ])) {
    const rendered = renderService(manager, { args, path });
    assert.match(rendered, /Written by `jev-router setup`/);
    assert.equal(manually(rendered, home, path), manually(readFileSync(new URL(template, import.meta.url), 'utf8'), home, path), manager);
  }
  const odd = renderService('systemd', {
    args: ['/usr/bin/env', 'jev-router', 'serve', '--env-file', '/a b/"x"/100%/$y', '--ui', '0'],
    path: '/p q/%',
  });
  assert.match(odd, /^ExecStart=\/usr\/bin\/env jev-router serve --env-file "\/a b\/\\"x\\"\/100%%\/\$\$y" --ui 0$/m);
  assert.match(odd, /^Environment="PATH=\/p q\/%%"$/m);
  const xml = renderService('launchd', { args: ['/usr/bin/env', 'jev-router', 'serve', '--env-file', '/a&b/<c>'], path: '/p&q' });
  assert.match(xml, /<string>\/a&amp;b\/&lt;c&gt;<\/string>/);
  assert.match(xml, /<string>\/p&amp;q<\/string>/);
});

test("Claude Code's settings: variables keep their order, new ones go at the end, and an emptied block goes", () => {
  /** @type {Record<string, unknown>} */
  const data = { model: 'opus', env: { B: 'b', ANTHROPIC_BASE_URL: 'old', A: 'a' }, permissions: { allow: [] } };
  const changes = changeSettingsEnv(data, { ANTHROPIC_BASE_URL: 'new', C: 'c', A: 'a', D: undefined });
  assert.deepEqual(changes, [
    { name: 'ANTHROPIC_BASE_URL', before: 'old', after: 'new' },
    { name: 'C', before: undefined, after: 'c' },
  ]);
  assert.equal(
    JSON.stringify(data),
    '{"model":"opus","env":{"B":"b","ANTHROPIC_BASE_URL":"new","A":"a","C":"c"},"permissions":{"allow":[]}}',
  );
  /** @type {Record<string, unknown>} */
  const fresh = {};
  changeSettingsEnv(fresh, { X: '1' });
  assert.deepEqual(fresh, { env: { X: '1' } });
  changeSettingsEnv(fresh, { X: undefined });
  assert.deepEqual(fresh, {}, 'a block left empty goes too');
  assert.deepEqual(settingsBlock({ env: { A: 'a', N: 1, O: null } }), { A: 'a' }, 'only strings');
});

test('ports: a port something holds is reported, a free one is not', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  assert.equal(await portProblem('127.0.0.1', port), 'EADDRINUSE');
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portProblem('127.0.0.1', port), undefined);
});

test('root: setup and uninstall refuse root on behalf of another user, through sudo or with their HOME', () => {
  assert.equal(rootProblem({ uid: 1000, sudoUid: undefined, homeOwner: 1000 }), undefined);
  assert.equal(rootProblem({ uid: 1000, sudoUid: '1000', homeOwner: 1000 }), undefined, 'SUDO_UID alone, as a user, is fine');
  assert.equal(rootProblem({ uid: 0, sudoUid: undefined, homeOwner: 0 }), undefined, "root in root's own home");
  assert.equal(rootProblem({ uid: 0, sudoUid: undefined, homeOwner: undefined }), undefined);
  assert.equal(rootProblem({ uid: 0, sudoUid: '501', homeOwner: 0 }), 'it runs as root through sudo');
  assert.equal(rootProblem({ uid: 0, sudoUid: undefined, homeOwner: 501 }), 'it runs as root, but HOME belongs to another user');
  assert.equal(rootProblem({ uid: undefined, sudoUid: '0', homeOwner: 0 }), undefined, 'Windows has no user ids');
});

test("service files: $' and $& in paths stay as they are, and a control character is refused", () => {
  const home = process.env.HOME;
  process.env.HOME = "/home/o$'neil$&co";
  try {
    const args = ['/usr/bin/env', 'jev-router', 'serve', '--config', "/c$'fg$&/config.json"];
    const plist = renderService('launchd', { args, path: "/p$'a$&th:/usr/bin" });
    assert.ok(plist.includes("<string>/c$'fg$&amp;/config.json</string>"), plist);
    assert.ok(plist.includes("<string>/p$'a$&amp;th:/usr/bin</string>"));
    assert.ok(plist.includes("<string>/home/o$'neil$&amp;co/Library/Logs/jev-router/router.err.log</string>"));
    const unit = renderService('systemd', { args, path: "/p$'a$&th:/usr/bin" });
    assert.match(unit, /^ExecStart=\/usr\/bin\/env jev-router serve --config "\/c\$\$'fg\$\$&\/config\.json"$/m);
    assert.match(unit, /^Environment="PATH=\/p\$'a\$&th:\/usr\/bin"$/m);
  } finally {
    process.env.HOME = home;
  }
  assert.throws(
    () => renderService('systemd', { args: ['/usr/bin/env', 'jev-router', 'serve', '--config', '/a\nb'], path: '/usr/bin' }),
    /control character/,
  );
  assert.throws(() => renderService('launchd', { args: ['/usr/bin/env'], path: '/usr/bin\u0000' }), /control character/);
  assert.throws(() => parseUiAddress('127.0.0.1\r:4100'), /--ui takes a port or host:port/);
  assert.deepEqual(parseUiAddress('[::1]:4100'), { host: '::1', port: 4100 });
});

test('Jev client: an error never carries the key, whether fetch quotes the header or the server echoes it', async () => {
  const key = fake('ts-', 'secret-', 'key');
  const jevCfg = {
    ...cfg.jev,
    deadlineMs: 2000,
    channels: [{ name: 'one', baseUrl: 'https://one.invalid', model: 'm', keyEnv: 'K', timeoutMs: 500 }],
  };
  /** @type {FetchLike} */
  const quoting = async () => {
    throw new TypeError(`Headers.append: "Bearer ${key}\r" is an invalid header value.`);
  };
  const answer = await new JevClient(jevCfg, { K: key }, { fetchImpl: quoting }).decide(stateOf('Add a test'));
  assert.ok(!answer.ok);
  assert.equal(answer.error, 'one: the key has characters an HTTP header cannot carry');
  /** @type {FetchLike} */
  const echoing = async () => new Response(JSON.stringify({ detail: { message: `bad key ${key}` } }), { status: 401 });
  const echoed = await new JevClient(jevCfg, { K: key }, { fetchImpl: echoing }).decide(stateOf('Add a test'));
  assert.ok(!echoed.ok && !echoed.error.includes(key), echoed.ok ? '' : echoed.error);
  assert.match(echoed.ok ? '' : echoed.error, /HTTP 401 bad key <key>/);
});

test('settings: a file that is not JSON is named without quoting it, and a symbolic link to a missing file gets that file', () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-settings-`);
  writeFileSync(`${dir}/settings.json`, '{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-not-json');
  assert.deepEqual(readSettings(`${dir}/settings.json`), { problem: "it isn't valid JSON" });
  symlinkSync(`${dir}/target/settings.json`, `${dir}/link.json`);
  mkdirSync(`${dir}/target`);
  writeFileAtomic(`${dir}/link.json`, '{}\n', 0o600);
  assert.ok(lstatSync(`${dir}/link.json`).isSymbolicLink());
  assert.equal(readFileSync(`${dir}/target/settings.json`, 'utf8'), '{}\n');
  /** @type {Record<string, unknown>} */
  const data = { env: { ENABLE_TOOL_SEARCH: true, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 90000 } };
  assert.deepEqual(changeSettingsEnv(data, { ENABLE_TOOL_SEARCH: 'true', CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }), []);
  assert.deepEqual(data, { env: { ENABLE_TOOL_SEARCH: true, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 90000 } }, 'values that are not strings stay');
  assert.deepEqual(settingsSet(data), { ENABLE_TOOL_SEARCH: 'true', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000' });
});

test('env file: /dev/null turns it off, by either name', () => {
  const env = { HOME: tmpdir(), XDG_CONFIG_HOME: tmpdir() };
  assert.equal(envFileFor(undefined, { ...env, JEV_ROUTER_ENV_FILE: '/dev/null' }), undefined);
  assert.equal(envFileFor('/dev/null', env), undefined);
  assert.equal(loadEnvFile('/dev/null', env), undefined);
});

test('launchd: when the agent never loads again, the error says it is unloaded and gives the command that loads it', async () => {
  const dir = mkdtempSync(`${tmpdir()}/jev-launchd-`);
  copyFileSync(new URL('./fakes/fake-service.mjs', import.meta.url), `${dir}/launchctl`);
  chmodSync(`${dir}/launchctl`, 0o755);
  symlinkSync(process.execPath, `${dir}/node`);
  const env = { PATH: dir, HOME: dir, FAKE_SERVICE_LOG: `${dir}/service.log`, FAKE_LAUNCHD: 'stuck' };
  const file = `${dir}/io.github.dirien.jev-router.plist`;
  const started = Date.now();
  await assert.rejects(startService('launchd', file, '<plist/>', env, { launchdWaitMs: 1200 }), (/** @type {Error} */ err) => {
    assert.match(
      err.message,
      /^launchd didn't load the agent again within 1 s \(Bootstrap failed: 5: Input\/output error\)\. It is unloaded now/,
    );
    assert.ok(err.message.endsWith(`Load it with:\n  launchctl bootstrap gui/${process.getuid?.()} ${file}`), err.message);
    return true;
  });
  assert.ok(Date.now() - started >= 1200, 'it kept trying until the time was up');
});
