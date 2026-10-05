// CLI tests. Every command runs through the real bin/jev-router.mjs in a child process (harness.mjs),
// with its own HOME, XDG directories and CODEX_HOME, and a PATH that holds only node.
// test/fakes/fake-agent.mjs stands in for claude and codex; Jev and the upstream providers are local
// mocks. No network, no real agent. setup and uninstall have their own file, setup.test.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { VERSION } from '../src/router.mjs';
import {
  ANTHROPIC_FABLE_CONFIG,
  ANTHROPIC_ONLY_CONFIG,
  ask,
  CLIENT_KEY,
  CODEX_MODELS,
  DEFAULT_CONFIG,
  FAKE_AGENT,
  fake,
  freePort,
  healthz,
  isListening,
  JEV_KEY,
  logEntries,
  logEvents,
  MOCK_KEY,
  mock,
  mockUpstream,
  OLLAMA_KEY,
  portOf,
  run,
  runningRouter,
  sandbox,
  servers,
  shipped,
  start,
  TOKEN,
  waitFor,
  writeConfig,
} from './harness.mjs';
import { jevOptionsAnswer, json, listen, sleep } from './helpers.mjs';

test('version, help, and a short error for an unknown command, option or usage', async () => {
  const { env } = sandbox();
  for (const args of [['version'], ['--version']]) {
    assert.deepEqual(await run(args, env), { code: 0, signal: null, stdout: `${VERSION}\n`, stderr: '' });
  }
  for (const args of [['help'], ['--help'], ['-h']]) {
    const help = await run(args, env);
    assert.equal(help.code, 0);
    for (const usage of [
      'setup [--yes]',
      'uninstall',
      'launch claude',
      'launch codex',
      'env claude|codex',
      'doctor',
      'init',
      'report [<log.jsonl>]',
    ]) {
      assert.ok(help.stdout.includes(`jev-router ${usage}`), usage);
    }
    assert.match(help.stdout, /\[--env-file <file>\]/);
    assert.match(help.stdout, /\$JEV_ROUTER_ENV_FILE/);
    assert.match(help.stdout, /\[--log-file <file>\]/);
    assert.match(help.stdout, /\$JEV_ROUTER_LOG_FILE/);
  }
  const unknown = await run(['frobnicate'], env);
  assert.deepEqual(unknown, {
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'jev-router: unknown command "frobnicate". Run "jev-router help" for usage.\n',
  });
  const usage = {
    '--frobnicate': ['--frobnicate'],
    'Usage: jev-router launch claude|codex': ['launch', 'gemini'],
    'Usage: jev-router env claude|codex': ['env'],
    'Usage: jev-router doctor': ['doctor', 'now'],
    'Usage: jev-router init': ['init', 'here'],
    'Usage: jev-router setup': ['setup', 'now'],
    'Usage: jev-router report': ['report', 'a.jsonl', 'b.jsonl'],
    'serve takes no arguments, got "now"': ['serve', 'now'],
    '--force takes no value': ['init', '--force=yes'],
    '--config needs a value': ['doctor', '--config'],
    'port must be a number from 0 to 65535, got "70000"': ['serve', '--port=70000'],
    'env needs the port the router listens on, not 0': ['env', 'claude', '--port', '0'],
  };
  for (const [message, args] of Object.entries(usage)) {
    const result = await run(args, env);
    assert.equal(result.code, 1, args.join(' '));
    assert.ok(result.stderr.startsWith('jev-router: ') && result.stderr.includes(message), `${args.join(' ')}: ${result.stderr}`);
  }
});

test('config resolution: --config, then JEV_ROUTER_CONFIG, then the user config, then the packaged default', async () => {
  const box = sandbox();
  /**
   * @param {string[]} args
   * @param {Record<string, string>} [extra] added to the sandbox environment
   * @param {Record<string, string>} [base] the environment to start from
   */
  const baseUrl = async (args, extra = {}, base = box.env) => {
    const result = await run(['env', 'claude', ...args], { ...base, ...extra });
    assert.equal(result.code, 0, result.stderr);
    return /^export ANTHROPIC_BASE_URL=(.*)$/m.exec(result.stdout)?.[1];
  };
  assert.equal(await baseUrl([]), 'http://127.0.0.1:4000', 'the packaged default');
  mkdirSync(join(box.config, 'jev-router'));
  writeConfig(join(box.config, 'jev-router', 'config.json'), { port: 4103 });
  assert.equal(await baseUrl([]), 'http://127.0.0.1:4103', 'the user config');
  const fromEnv = writeConfig(join(box.root, 'env.json'), { port: 4102 });
  assert.equal(await baseUrl([], { JEV_ROUTER_CONFIG: fromEnv }), 'http://127.0.0.1:4102', 'JEV_ROUTER_CONFIG beats the user config');
  const fromFlag = writeConfig(join(box.root, 'flag.json'), { port: 4101 });
  assert.equal(await baseUrl(['--config', fromFlag], { JEV_ROUTER_CONFIG: fromEnv }), 'http://127.0.0.1:4101', '--config beats both');
  assert.equal(await baseUrl([`--config=${fromFlag}`]), 'http://127.0.0.1:4101', '--name=value works too');

  assert.equal(await baseUrl([], { JEV_ROUTER_PORT: '4104' }), 'http://127.0.0.1:4104', 'JEV_ROUTER_PORT beats the config');
  assert.equal(await baseUrl(['--port', '4105'], { JEV_ROUTER_PORT: '4104' }), 'http://127.0.0.1:4105', '--port beats JEV_ROUTER_PORT');
  assert.equal(await baseUrl([], { JEV_ROUTER_HOST: '::1' }), "'http://[::1]:4103'", 'IPv6 in brackets, quoted against globbing');
  assert.equal(
    await baseUrl([], { JEV_ROUTER_HOST: '0.0.0.0' }),
    'http://127.0.0.1:4103',
    'a router on every interface is reached on loopback',
  );

  const { XDG_CONFIG_HOME, ...noXdg } = box.env;
  mkdirSync(join(box.home, '.config', 'jev-router'), { recursive: true });
  writeConfig(join(box.home, '.config', 'jev-router', 'config.json'), { port: 4106 });
  assert.equal(await baseUrl([], {}, noXdg), 'http://127.0.0.1:4106', 'without XDG_CONFIG_HOME, ~/.config');

  const missing = await run(['env', 'claude'], { ...box.env, JEV_ROUTER_CONFIG: join(box.root, 'missing.json') });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^jev-router: Cannot read config .*missing\.json/);
});

test('env claude prints shell-safe exports, and env codex explains the profile', async () => {
  const box = sandbox();
  const plain = await run(['env', 'claude', '--port', '4555'], box.env);
  assert.equal(
    plain.stdout,
    'export ANTHROPIC_BASE_URL=http://127.0.0.1:4555\nexport CLAUDE_CODE_GATEWAY_HINT_HEADERS=1\nexport CLAUDE_CODE_AUTO_COMPACT_WINDOW=160000\nexport ENABLE_TOOL_SEARCH=true\n',
  );
  assert.equal(plain.stderr, 'jev-router: nothing answers at http://127.0.0.1:4555 yet. Start a router with: jev-router serve\n');

  const withToken = await run(['env', 'claude', '--port', '4555'], {
    ...box.env,
    JEV_ROUTER_TOKEN: `${TOKEN}$(touch pwned)`,
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: blue\nX-Jev-Router-Token: stale',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000',
    ENABLE_TOOL_SEARCH: 'auto',
  });
  assert.ok(!withToken.stdout.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW'), "the user's own compaction window stays");
  assert.ok(!withToken.stdout.includes('ENABLE_TOOL_SEARCH'), "the user's own tool search setting stays");
  // A real shell evaluates the exports: quotes, $ and newlines must survive, and nothing may run.
  const shell = spawnSync('/bin/sh', ['-c', `${withToken.stdout}printf '%s' "$ANTHROPIC_CUSTOM_HEADERS"`], {
    cwd: box.root,
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  assert.equal(shell.stdout, `x-team: blue\nx-jev-router-token: ${TOKEN}$(touch pwned)`);
  assert.ok(!existsSync(join(box.root, 'pwned')));

  const { port } = await runningRouter();
  assert.equal((await run(['env', 'claude', '--port', String(port)], box.env)).stderr, '', 'no hint when a router answers');

  const codex = await run(['env', 'codex', '--port', '4555'], box.env);
  assert.equal(codex.code, 0);
  assert.ok(
    codex.stdout
      .trimEnd()
      .split('\n')
      .every((line) => line.startsWith('#')),
    'only comments, so eval runs nothing',
  );
  assert.ok(codex.stdout.includes(`# Profile: ${join(box.codex, 'jev.config.toml')} (not written yet`));
  assert.ok(codex.stdout.includes('# Router:  http://127.0.0.1:4555/v1'));
  assert.ok(codex.stdout.includes('codex --profile jev'));
});

test('init writes the user config once; --force overwrites it; --models picks the packaged config', async () => {
  const box = sandbox();
  const target = join(box.config, 'jev-router', 'config.json');
  const first = await run(['init'], box.env);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(first.stdout.includes(target));
  assert.equal(readFileSync(target, 'utf8'), readFileSync(DEFAULT_CONFIG, 'utf8'));
  assert.equal(statSync(target).mode & 0o777, 0o600);

  writeFileSync(target, '{"edited": true}');
  const again = await run(['init', '--anthropic-only'], box.env);
  assert.equal(again.code, 1);
  assert.equal(again.stderr, `jev-router: ${target} already exists. Pass --force to overwrite it.\n`);
  assert.equal(readFileSync(target, 'utf8'), '{"edited": true}');

  const forced = await run(['init', '--anthropic-only', '--force'], box.env);
  assert.equal(forced.code, 0);
  assert.equal(readFileSync(target, 'utf8'), readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'));
  assert.match((await run(['doctor'], box.env)).stdout, /config {4}.*config\.json \(user config\)/, 'the next command uses it');

  const fable = await run(['init', '--models', 'fable', '--force'], box.env);
  assert.equal(fable.code, 0, fable.stderr);
  assert.equal(
    fable.stdout,
    `Wrote ${target} from the packaged anthropic-fable.json.\nNext: set your Jev key, then run: jev-router doctor\n`,
  );
  assert.equal(readFileSync(target, 'utf8'), readFileSync(ANTHROPIC_FABLE_CONFIG, 'utf8'));
  assert.equal((await run(['init', '--models', 'claude', '--anthropic-only', '--force'], box.env)).code, 0, 'the old flag agrees');
  assert.equal(readFileSync(target, 'utf8'), readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'));
  assert.equal(
    (await run(['init', '--models', 'fable', '--anthropic-only', '--force'], box.env)).stderr,
    'jev-router: --anthropic-only is --models claude, not --models fable\n',
  );
  assert.equal((await run(['init', '--models', 'gpt'], box.env)).stderr, 'jev-router: --models takes claude, fable or ollama, got "gpt"\n');
  assert.equal(readFileSync(target, 'utf8'), readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'), 'a refused init writes nothing');

  const { XDG_CONFIG_HOME, ...noXdg } = box.env;
  assert.equal((await run(['init'], noXdg)).code, 0);
  assert.ok(existsSync(join(box.home, '.config', 'jev-router', 'config.json')), 'without XDG_CONFIG_HOME, ~/.config');
});

test('doctor reports config, keys, proxy and router, exits 1 only when routing cannot work, and never prints a secret', async () => {
  const box = sandbox();
  const env = { ...box.env, JEV_ROUTER_PORT: String(await freePort()) };
  const none = await run(['doctor'], env);
  assert.equal(none.code, 1);
  assert.match(none.stdout, /^jev-router \d+\.\d+\.\d+ doctor$/m);
  assert.match(none.stdout, /^ {2}ok {3}config {4}.*default\.json \(packaged default\)$/m);
  assert.match(none.stdout, /^ {2}ok {3}node {6}v\d+/m);
  assert.match(none.stdout, /^ {2}FAIL jev {7}no Jev channel has a key, so every session would get the default tier "balanced"/m);
  assert.match(none.stdout, /^ {2}info router {4}nothing answers at http:\/\/127\.0\.0\.1:\d+; start one with: jev-router serve$/m);
  assert.match(none.stdout, /Not ready: fix the FAIL lines above\.\n$/);

  const proxy = fake('http://user:', 'proxy-pass', '@proxy.example:3128');
  const keys = { TYPESAFE_API_KEY: JEV_KEY, OLLAMA_API_KEY: OLLAMA_KEY, HTTPS_PROXY: proxy };
  const ready = await run(['doctor'], { ...env, ...keys });
  assert.equal(ready.code, 0, ready.stdout);
  for (const line of [
    /ok {3}jev {7}typesafe: TYPESAFE_API_KEY is set$/m,
    /warn jev {7}openrouter: OPENROUTER_API_KEY is not set$/m,
    /ok {3}upstream {2}ANTHROPIC_API_KEY is not set: anthropic\.side, .*anthropic\.trusted pass the client's own login through$/m,
    /ok {3}upstream {2}OLLAMA_API_KEY is set: anthropic\.fast, openai\.fast, openai\.balanced$/m,
    /warn upstream {2}OPENAI_API_KEY is not set: openai\.frontier, openai\.trusted will fail$/m,
    /hint proxy {5}HTTPS_PROXY is set, but Node ignores it without NODE_USE_ENV_PROXY=1$/m,
    /Ready\. Start a session with: jev-router launch claude\n$/,
  ]) {
    assert.match(ready.stdout, line);
  }
  for (const secret of [JEV_KEY, OLLAMA_KEY, 'proxy-pass']) {
    assert.ok(!`${ready.stdout}${ready.stderr}`.includes(secret), 'a secret reached the output');
  }
  assert.match(
    (await run(['doctor'], { ...env, ...keys, NODE_USE_ENV_PROXY: '1' })).stdout,
    /ok {3}proxy {5}HTTPS_PROXY is set and NODE_USE_ENV_PROXY=1/,
  );

  const direct = await run(['doctor'], { ...env, JEV_BASE_URL: 'http://127.0.0.1:9', JEV_API_KEY: JEV_KEY });
  assert.equal(direct.code, 0, 'JEV_BASE_URL with JEV_API_KEY is a Jev channel too');
  assert.match(direct.stdout, /ok {3}jev {7}env: JEV_BASE_URL and JEV_API_KEY are set/);

  const bad = writeConfig(join(box.root, 'bad.json'), { port: 'eighty', defaultTier: 'cheapest' });
  const invalid = await run(['doctor', '--config', bad], { ...env, ...keys });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /FAIL config {4}.*bad\.json \(--config\)\n {17}Invalid router config:/);
  assert.match(invalid.stdout, /- port must be an integer between 1 and 65535/);
  assert.match(invalid.stdout, /- defaultTier "cheapest" is not one of tiers/);
  assert.doesNotMatch(invalid.stdout, /upstream/, 'no key checks against a config that failed to load');

  const badPort = await run(['doctor'], { ...box.env, ...keys, JEV_ROUTER_PORT: 'eighty' });
  assert.equal(badPort.code, 1);
  assert.match(badPort.stdout, /FAIL router {4}port must be a number from 0 to 65535, got "eighty"/);
});

test('doctor reports a keyless loopback channel and refuses a keyless one that is not loopback', async () => {
  const box = sandbox();
  const port = String(await freePort());
  const local = writeConfig(join(box.root, 'local.json'), {
    jev: { ...shipped.jev, channels: [{ name: 'ollama', baseUrl: 'http://127.0.0.1:11435', model: 'nimble' }] },
  });
  const listed = await run(['doctor', '--config', local], { ...box.env, JEV_ROUTER_PORT: port, TYPESAFE_API_KEY: JEV_KEY });
  assert.equal(listed.code, 0, listed.stdout);
  assert.match(listed.stdout, /ok {3}jev {7}ollama: local channel at http:\/\/127\.0\.0\.1:11435, model nimble, no key/);
  assert.ok(!listed.stdout.includes(JEV_KEY), 'the hosted key is not printed');

  const remote = writeConfig(join(box.root, 'remote.json'), {
    jev: { ...shipped.jev, channels: [{ name: 'ollama', baseUrl: 'http://10.1.2.3:11434', model: 'nimble' }] },
  });
  const refused = await run(['doctor', '--config', remote], { ...box.env, JEV_ROUTER_PORT: port });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /keyEnv is required \(a channel without a key is only allowed on a loopback address\)/);

  const envOnly = await run(['doctor'], { ...box.env, JEV_ROUTER_PORT: port, JEV_BASE_URL: 'http://127.0.0.1:11435', JEV_MODEL: 'tev1' });
  assert.equal(envOnly.code, 0, envOnly.stdout);
  assert.match(envOnly.stdout, /ok {3}jev {7}env: JEV_BASE_URL is a local channel, model tev1, no key/);

  const envRemote = await run(['doctor'], { ...box.env, JEV_ROUTER_PORT: port, JEV_BASE_URL: 'https://jev.example' });
  assert.equal(envRemote.code, 1);
  assert.match(envRemote.stdout, /JEV_BASE_URL without JEV_API_KEY is only allowed for a loopback address/);
});

test('doctor shows a running router with its version and Jev channels, and spots other servers on the port', async () => {
  const box = sandbox();
  const { port } = await runningRouter({ TYPESAFE_API_KEY: JEV_KEY });
  const running = await run(['doctor'], { ...box.env, TYPESAFE_API_KEY: JEV_KEY, JEV_ROUTER_PORT: String(port) });
  assert.equal(running.code, 0);
  assert.match(
    running.stdout,
    new RegExp(
      `ok {3}router {4}jev-router ${VERSION} answers at http://127\\.0\\.0\\.1:${port} \\(up \\d+ s, 0 sessions\\); Jev: typesafe ok \\(0 calls, 0 errors\\)`,
    ),
  );
  const { port: keyless } = await runningRouter();
  assert.match((await run(['doctor'], { ...box.env, JEV_ROUTER_PORT: String(keyless) })).stdout, /Jev: no channel has a key$/m);

  // Healthy JSON on /healthz isn't enough: it has to be a jev-router's.
  const other = http.createServer((_req, res) => json(res, 200, { ok: true }));
  servers.push(other);
  const otherPort = portOf(await listen(other));
  const found = await run(['doctor'], { ...box.env, JEV_ROUTER_PORT: String(otherPort) });
  assert.match(
    found.stdout,
    new RegExp(`warn router {4}something answers at http://127\\.0\\.0\\.1:${otherPort}, but it is not a jev-router`),
  );

  // A server that takes the request and never answers costs a second, not a hang.
  const silent = http.createServer(() => {
    // never answers
  });
  servers.push(silent);
  const silentPort = portOf(await listen(silent));
  const hung = await run(['doctor'], { ...box.env, JEV_ROUTER_PORT: String(silentPort) });
  assert.match(hung.stdout, new RegExp(`info router {4}nothing answers at http://127\\.0\\.0\\.1:${silentPort}`));
});

/** @param {string} text matched as it is in a regular expression */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('doctor checks the env file, the log file and Claude Code settings, and adds no line for them on a plain machine', async () => {
  const box = sandbox();
  const env = { ...box.env, JEV_ROUTER_PORT: String(await freePort()) };
  const plain = await run(['doctor'], { ...env, TYPESAFE_API_KEY: JEV_KEY });
  assert.equal(plain.code, 0, plain.stdout);
  assert.doesNotMatch(plain.stdout, /env-file|log {7}|claude {4}|proxy {5}/, 'no proxy, env file, log or Claude Code line without them');

  const envFile = join(box.root, 'router.env');
  writeFileSync(envFile, `TYPESAFE_API_KEY=${JEV_KEY}\nHTTPS_PROXY=http://proxy.example:3128\n`);
  chmodSync(envFile, 0o640);
  const withFile = await run(['doctor', '--env-file', envFile], env);
  assert.equal(withFile.code, 0, withFile.stdout);
  for (const line of [
    new RegExp(`^ {2}ok {3}env-file {2}${literal(envFile)} \\(--env-file\\) sets HTTPS_PROXY, TYPESAFE_API_KEY$`, 'm'),
    new RegExp(
      `^ {2}warn env-file {2}other users can read ${literal(envFile)} \\(mode 640\\), which holds API keys\\. Run: chmod 600 `,
      'm',
    ),
    /^ {2}warn env-file {2}HTTPS_PROXY in .* has no effect: Node reads it only when it starts\./m,
    /^ {2}ok {3}jev {7}typesafe: TYPESAFE_API_KEY is set$/m,
  ])
    assert.match(withFile.stdout, line);
  assert.doesNotMatch(withFile.stdout, /proxy {5}/, "a proxy from the env file is left to the file's own warning");
  assert.ok(!withFile.stdout.includes(JEV_KEY), 'a key reached the output');
  const broken = await run(['doctor'], { ...env, JEV_ROUTER_ENV_FILE: join(box.root, 'gone.env') });
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /^ {2}FAIL env-file {2}Cannot read env file .*gone\.env \(JEV_ROUTER_ENV_FILE\): no such file$/m);

  mkdirSync(join(box.config, 'jev-router'), { recursive: true });
  const standard = join(box.config, 'jev-router', 'env');
  writeFileSync(standard, `TYPESAFE_API_KEY=${JEV_KEY}\n`);
  chmodSync(standard, 0o600);
  const found = await run(['doctor'], { ...env, TYPESAFE_API_KEY: JEV_KEY });
  assert.match(
    found.stdout,
    new RegExp(
      `^ {2}ok {3}env-file {2}${literal(standard)} \\(default location\\) sets nothing: its variables are all set already, and those win$`,
      'm',
    ),
  );
  assert.doesNotMatch(found.stdout, /other users can/, 'mode 600 is fine');
  rmSync(standard);

  const keys = { ...env, TYPESAFE_API_KEY: JEV_KEY };
  const nowhere = writeConfig(join(box.root, 'log-missing.json'), { logFile: join(box.root, 'nowhere', 'router.log') });
  assert.match(
    (await run(['doctor', '--config', nowhere], keys)).stdout,
    /^ {2}warn log {7}.*nowhere\/router\.log \(logFile\): .*nowhere doesn't exist, so nothing is logged there\./m,
  );
  const fine = writeConfig(join(box.root, 'log-fine.json'), { logFile: join(box.root, 'router.log'), logMaxBytes: 0 });
  assert.match((await run(['doctor', '--config', fine], keys)).stdout, /^ {2}ok {3}log {7}.*router\.log \(logFile\); never rotates/m);
  assert.match(
    (await run(['doctor'], { ...keys, JEV_ROUTER_LOG_FILE: '~/logs/router.log' })).stdout,
    /^ {2}ok {3}log {7}.*\/logs\/router\.log \(JEV_ROUTER_LOG_FILE\): serve creates .*\/logs; rotates at 50 MiB$/m,
  );

  const routerUrl = `http://127.0.0.1:${env.JEV_ROUTER_PORT}`;
  const shell = await run(['doctor'], { ...keys, ANTHROPIC_BASE_URL: routerUrl, CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1' });
  const hints = shell.stdout.split('\n').filter((line) => line.startsWith('  hint claude'));
  assert.deepEqual(
    hints.map((line) => /but (\w+) is not set/.exec(line)?.[1]),
    ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'ENABLE_TOOL_SEARCH'],
  );
  assert.match(shell.stdout, /ANTHROPIC_BASE_URL in this shell\), but ENABLE_TOOL_SEARCH is not set: .*Set ENABLE_TOOL_SEARCH=true\.$/m);
  mkdirSync(join(box.home, '.claude'), { recursive: true });
  const settings = {
    ANTHROPIC_BASE_URL: routerUrl,
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000',
    ENABLE_TOOL_SEARCH: 'true',
  };
  writeFileSync(join(box.home, '.claude', 'settings.json'), JSON.stringify({ env: settings }));
  assert.match(
    (await run(['doctor'], keys)).stdout,
    /^ {2}ok {3}claude {4}Claude Code uses the router \(ANTHROPIC_BASE_URL in .*settings\.json\) with the gateway settings it needs$/m,
  );
  const direct = await run(['doctor'], { ...keys, HOME: join(box.root, 'other-home'), ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
  assert.doesNotMatch(direct.stdout, /claude {4}/, 'Claude Code that goes to Anthropic directly gets no line');
});

test('doctor --live makes one Jev call through a local System One mock', async () => {
  const box = sandbox();
  const jev = await mock((_call, res) => json(res, 200, jevOptionsAnswer({ option: 'routine', model: 'jev-1.13.0-mock' })));
  const down = await mock((_call, res) => json(res, 401, { detail: { message: 'invalid key' } }));
  const env = { ...box.env, MOCK_JEV_KEY: MOCK_KEY, JEV_ROUTER_PORT: String(await freePort()) };

  const live = await run(['doctor', '--live', '--config', writeConfig(join(box.root, 'live.json'), {}, { jev: jev.url })], env);
  assert.equal(live.code, 0, live.stdout);
  assert.match(live.stdout, /ok {3}live {6}mock answered in \d+ ms with jev-1\.13\.0-mock \(choice: routine\)$/m);
  assert.equal(jev.calls.length, 1, 'exactly one Jev call');
  assert.equal(jev.calls[0].url, '/v1/systemone');
  assert.equal(jev.calls[0].headers.authorization, `Bearer ${MOCK_KEY}`);
  assert.ok(!`${live.stdout}${live.stderr}`.includes(MOCK_KEY), 'the key never reaches the output');

  const failing = await run(['doctor', '--live', '--config', writeConfig(join(box.root, 'down.json'), {}, { jev: down.url })], env);
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /FAIL live {6}no answer after \d+ ms: mock: HTTP 401 invalid key$/m);

  const { MOCK_JEV_KEY, ...keyless } = env;
  const skipped = await run(['doctor', '--live', '--config', writeConfig(join(box.root, 'keyless.json'), {}, { jev: jev.url })], keyless);
  assert.match(skipped.stdout, /info live {6}skipped: no Jev channel has a key$/m);
  assert.equal(jev.calls.length, 1, 'no call without a key');
});

test('report reads a log file, the config logFile, or the log launch writes', async () => {
  const box = sandbox();
  const lines = [
    { event: 'route', session: 's1', jev: { ok: true, ms: 120, inputTokens: 600 } },
    { event: 'done', model: 'claude-sonnet-5', usage: { input: 10, cacheRead: 0, output: 5 }, cost_usd: 0.001, baseline_usd: 0.004 },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  const file = join(box.root, 'router.jsonl');
  writeFileSync(file, lines);

  const direct = await run(['report', file], box.env);
  assert.equal(direct.code, 0, direct.stderr);
  const summary = JSON.parse(direct.stdout);
  assert.equal(summary.requests, 1);
  assert.equal(summary.saved_usd, 0.003);
  assert.equal(summary.jev.calls, 1);

  const nothing = await run(['report'], box.env);
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /Usage: jev-router report <log\.jsonl> \(or set JEV_ROUTER_LOG_FILE, or logFile in the config\)/);
  const configured = await run(['report', '--config', writeConfig(join(box.root, 'log.json'), { logFile: file })], box.env);
  assert.equal(JSON.parse(configured.stdout).requests, 1, 'the config logFile');
  mkdirSync(join(box.state, 'jev-router'));
  writeFileSync(join(box.state, 'jev-router', 'router.log'), `${lines}\n${lines}`);
  assert.equal(JSON.parse((await run(['report'], box.env)).stdout).requests, 2, 'the log launch writes');
  const missing = await run(['report', join(box.root, 'nope.jsonl')], box.env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /ENOENT/);
});

test('serve logs JSON to stdout and the logFile, reloads on SIGHUP, and drains on SIGTERM', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const logFile = join(box.root, 'serve.log');
  const config = writeConfig(join(box.root, 'serve.json'), { logFile }, { upstream: upstream.url });
  // `jev-router --config …` is `jev-router serve --config …`
  const serving = start(['--config', config, '--port', '0'], box.env);
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  assert.equal((await healthz(url)).ok, true);

  assert.equal((await ask(url)).status, 200);
  await waitFor(() => serving.out.stdout.includes('"event":"done"'), 'the done line');
  assert.deepEqual(logEvents(serving.out.stdout), ['config', 'warning', 'route', 'done']);
  const [configured, , route, done] = logEntries(serving.out.stdout);
  assert.equal(configured.version, VERSION);
  assert.deepEqual(configured.tiers, shipped.tiers);
  assert.equal(configured.surfaces.anthropic.frontier.model, shipped.surfaces.anthropic.frontier.model);
  assert.equal(configured.surfaces.anthropic.frontier.upstream, new URL(upstream.url).host);
  assert.equal(configured.options.mechanical, shipped.jev.options.mechanical.tier);
  assert.doesNotMatch(JSON.stringify(configured), /keyEnv|_KEY|token/i, 'no keys or key names in the config line');
  assert.equal(route.req, 1);
  assert.equal(done.req, route.req, 'route and done pair up by req');
  assert.equal(readFileSync(logFile, 'utf8'), serving.out.stdout, 'the logFile gets the same lines');
  assert.equal(upstream.calls[0].headers['x-api-key'], CLIENT_KEY, "no router key, so the client's login goes through");

  writeFileSync(config, '{ not json');
  serving.child.kill('SIGHUP');
  await waitFor(() => serving.out.stderr.includes('reload failed, keeping the old config'), 'the failed reload');
  const missingDir = join(box.root, 'no-such-dir');
  const unwritable = join(missingDir, 'serve.log');
  writeConfig(config, { logFile: unwritable }, { upstream: upstream.url });
  serving.child.kill('SIGHUP');
  await waitFor(() => serving.out.stderr.includes('jev-router: config reloaded'), 'the reload');
  await waitFor(() => logEvents(serving.out.stdout).length === 6, 'the reloaded config line and its warning');
  const problem = `cannot write the log file ${unwritable}: its directory does not exist. Its lines are lost until it can be written.`;
  assert.deepEqual(logEntries(serving.out.stdout).slice(4), [
    { ...logEntries(serving.out.stdout)[4], event: 'config' },
    { ts: logEntries(serving.out.stdout)[5].ts, event: 'warning', message: problem },
  ]);

  // Neither a logFile that can't be written nor a closed stdout pipe may stop the router, and the
  // failing file is reported once, not on every line.
  const logged = readFileSync(logFile, 'utf8');
  assert.equal((await ask(url)).status, 200);
  await waitFor(() => logEvents(serving.out.stdout).length === 8, 'the next two lines on stdout');
  assert.equal(readFileSync(logFile, 'utf8'), logged, 'the reloaded config moved the logFile');
  assert.equal(serving.out.stderr.split(problem).length - 1, 1, 'one note on stderr');
  mkdirSync(missingDir);
  assert.equal((await ask(url)).status, 200);
  await waitFor(() => serving.out.stderr.includes(`the log file ${unwritable} can be written again`), 'the recovery note');
  assert.deepEqual(logEvents(readFileSync(unwritable, 'utf8')), ['route', 'done']);
  serving.child.stdout.destroy();
  for (let i = 0; i < 3; i += 1) assert.equal((await ask(url)).status, 200);

  serving.child.kill('SIGTERM');
  const { code } = await serving.done;
  assert.equal(code, 0);
  assert.match(serving.out.stderr, /shutting down, waiting for 0 request\(s\)/);
  assert.equal(await isListening(portOf(url)), false);
});

test('a log file on a full disk costs its lines, never a request', { skip: !existsSync('/dev/full') && 'no /dev/full' }, async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'full.json'), { logFile: '/dev/full' }, { upstream: upstream.url });
  const serving = start(['serve', '--config', config, '--port', '0'], box.env);
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  assert.equal((await ask(url)).status, 200);
  await waitFor(() => serving.out.stdout.includes('"event":"done"'), 'the done line');
  const warnings = logEntries(serving.out.stdout).filter((entry) => entry.event === 'warning' && entry.message.includes('/dev/full'));
  assert.deepEqual(
    warnings.map((entry) => entry.message),
    ['cannot write the log file /dev/full: no space left on the device. Its lines are lost until it can be written.'],
  );
  serving.child.kill('SIGTERM');
  assert.equal((await serving.done).code, 0);
});

test('serve drains open streams on SIGTERM, and a second signal stops it at once', async () => {
  const box = sandbox();
  const holding = await mock((_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\ndata: {"type":"ping"}\n\n'); // and never ends
  });
  const config = writeConfig(join(box.root, 'drain.json'), {}, { upstream: holding.url });
  const serving = start(['serve', '--config', config, '--port', '0'], box.env);
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CLIENT_KEY },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Add a test' }] }),
  });
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  await reader.read();
  serving.child.kill('SIGTERM');
  await waitFor(() => serving.out.stderr.includes('shutting down, waiting for 1 request(s)'), 'the drain');
  await sleep(200);
  assert.equal(serving.child.exitCode, null, 'the open stream holds the shutdown');
  serving.child.kill('SIGINT');
  const { code } = await serving.done;
  assert.equal(code, 128 + 2, 'a second signal stops it at once, as SIGINT would');
  assert.match(serving.out.stderr, /stopping now, cutting 1 request\(s\)/);
  await reader.cancel().catch(() => undefined);
});

test('serve keeps routing when its stderr goes away (regression: the next message killed it)', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'stderr.json'), {}, { upstream: upstream.url });
  const serving = start(['serve', '--config', config, '--port', '0'], box.env);
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  serving.child.stderr.destroy();
  serving.child.kill('SIGHUP'); // "config reloaded" goes to the closed stderr
  await waitFor(() => logEvents(serving.out.stdout).filter((event) => event === 'config').length === 2, 'the reload');
  await sleep(100);
  assert.equal(serving.child.exitCode, null, 'still running');
  assert.equal((await ask(url)).status, 200);
  serving.child.kill('SIGTERM');
  assert.equal((await serving.done).code, 0);
});

test('serve and launch rotate their log files at logMaxBytes without losing a line, and report reads both files', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const logFile = join(box.root, 'rotating.log');
  const config = writeConfig(join(box.root, 'rotate.json'), { logFile, logMaxBytes: 2000 }, { upstream: upstream.url });
  const serving = start(['serve', '--config', config, '--port', '0'], box.env);
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  for (let i = 0; i < 4; i += 1) assert.equal((await ask(url)).status, 200);
  await waitFor(() => logEvents(serving.out.stdout).filter((event) => event === 'done').length === 4, 'the four done lines');
  serving.child.kill('SIGTERM');
  assert.equal((await serving.done).code, 0);
  const kept = readFileSync(`${logFile}.1`, 'utf8') + readFileSync(logFile, 'utf8');
  assert.ok(serving.out.stdout.endsWith(kept), 'the two files hold the newest lines in order, with none missing');
  assert.ok(statSync(logFile).size <= 2000, 'the current file stays under the limit');
  assert.equal(statSync(`${logFile}.1`).mode & 0o777, 0o600);
  const summary = JSON.parse((await run(['report', '--config', config], box.env)).stdout);
  assert.equal(summary.requests, logEvents(kept).filter((event) => event === 'route').length, 'the report reads the rotated file too');
  assert.equal(
    JSON.parse((await run(['report', logFile], box.env)).stdout).requests,
    logEvents(readFileSync(logFile, 'utf8')).filter((e) => e === 'route').length,
    'a file named on the command line is read alone',
  );

  const launchLog = join(box.root, 'launch-extra.log');
  const launchConfig = writeConfig(
    join(box.root, 'launch-rotate.json'),
    { logFile: launchLog, logMaxBytes: 1500 },
    { upstream: upstream.url },
  );
  const env = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT, FAKE_AGENT_REQUEST: '1', FAKE_CLIENT_KEY: CLIENT_KEY };
  assert.equal((await run(['launch', 'claude', '--config', launchConfig, '--port', '0'], env)).code, 0);
  const own = join(box.state, 'jev-router', 'router.log');
  for (const file of [own, launchLog]) {
    assert.ok(existsSync(`${file}.1`), `${file} rotated`);
    assert.deepEqual(logEvents(readFileSync(`${file}.1`, 'utf8') + readFileSync(file, 'utf8')), ['config', 'warning', 'route', 'done']);
  }
});

test('serve --log-file, else JEV_ROUTER_LOG_FILE, names the log file ahead of the config, makes its directory and rotates it', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const fromConfig = join(box.root, 'config.log');
  const config = writeConfig(join(box.root, 'log-file.json'), { logFile: fromConfig, logMaxBytes: 2000 }, { upstream: upstream.url });
  const flagged = join(box.root, 'logs', 'nested', 'router.log');
  const fromEnv = join(box.root, 'env-logs', 'router.log');
  const serving = start(['serve', '--config', config, '--port', '0', '--log-file', flagged], { ...box.env, JEV_ROUTER_LOG_FILE: fromEnv });
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  for (let i = 0; i < 3; i += 1) assert.equal((await ask(url)).status, 200);
  await waitFor(() => logEvents(serving.out.stdout).filter((event) => event === 'done').length === 3, 'the three done lines');
  serving.child.kill('SIGTERM');
  assert.equal((await serving.done).code, 0);
  for (const dir of [join(box.root, 'logs'), join(box.root, 'logs', 'nested')]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  assert.ok(existsSync(`${flagged}.1`), 'it rotates at logMaxBytes');
  assert.ok(serving.out.stdout.endsWith(readFileSync(`${flagged}.1`, 'utf8') + readFileSync(flagged, 'utf8')), 'with every line kept');
  assert.ok(!existsSync(fromConfig), "the flag wins over the config's logFile");
  assert.ok(!existsSync(fromEnv), 'and over JEV_ROUTER_LOG_FILE');

  // A service manager passes a leading ~ as it is.
  const withEnv = { ...box.env, JEV_ROUTER_LOG_FILE: '~/Library/Logs/jev-router/router.log' };
  const second = start(['serve', '--config', config, '--port', '0'], withEnv);
  const secondUrl = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(second.out.stderr)?.[1], 'the second router');
  assert.equal((await ask(secondUrl)).status, 200);
  await waitFor(() => second.out.stdout.includes('"event":"done"'), 'the done line');
  second.child.kill('SIGTERM');
  assert.equal((await second.done).code, 0);
  const inHome = join(box.home, 'Library', 'Logs', 'jev-router', 'router.log');
  assert.deepEqual(
    logEvents(readFileSync(inHome, 'utf8')),
    ['config', 'warning', 'route', 'done'],
    'JEV_ROUTER_LOG_FILE, with ~ as the home',
  );
  assert.ok(!existsSync(fromConfig));
  assert.equal(JSON.parse((await run(['report', '--config', config], withEnv)).stdout).requests, 1, 'report reads the same file');
});

test('ui serves the live view of a log that may not exist yet, and stops on SIGTERM', async () => {
  const box = sandbox();
  const log = join(box.root, 'later.log');
  const viewing = start(['ui', log, '--port', '0'], box.env);
  const url = await waitFor(() => /open (http:\/\/127\.0\.0\.1:\d+\/)\n/.exec(viewing.out.stderr)?.[1], 'the view to listen');
  assert.match(viewing.out.stderr, /not there yet/);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.match(await page.text(), /app\.js/, 'the packaged page');
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  viewing.child.kill('SIGTERM');
  assert.equal((await viewing.done).code, 0);

  const extra = await run(['ui', 'a.log', 'b.log'], box.env);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /Usage: jev-router ui/);
  const badPort = await run(['ui', log, '--port', 'x'], box.env);
  assert.equal(badPort.code, 1);
  assert.match(badPort.stderr, /port must be a number/);
});

test("serve --ui shows the router's own entries live, and a view that cannot listen never stops routing", async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'ui.json'), {}, { upstream: upstream.url });
  const serving = start(['serve', '--config', config, '--port', '0', '--ui', '127.0.0.1:0'], box.env);
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router');
  const view = await waitFor(() => /live view on (http:\/\/127\.0\.0\.1:\d+\/)\n/.exec(serving.out.stderr)?.[1], 'the view');
  const page = await fetch(`${view}events`);
  assert.equal(page.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = /** @type {ReadableStream<Uint8Array>} */ (page.body).getReader();
  const decoder = new TextDecoder();
  let text = '';
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  })();
  await waitFor(() => text.includes('event: snapshot') && text.includes('"event":"config"'), 'the config in the snapshot');
  assert.equal((await ask(url)).status, 200);
  await waitFor(() => text.includes('"event":"route"') && text.includes('"event":"done"'), 'the request in the view');
  serving.child.kill('SIGHUP');
  await waitFor(() => text.includes('jev-router: config reloaded'), 'the reload notice in the view');
  assert.doesNotMatch(serving.out.stderr, /listens on/, 'a loopback view needs no warning');
  await reader.cancel();
  serving.child.kill('SIGTERM');
  assert.equal((await serving.done).code, 0);

  const holder = http.createServer();
  const taken = await new Promise((done) =>
    holder.listen(0, '127.0.0.1', () => done(/** @type {import('node:net').AddressInfo} */ (holder.address()).port)),
  );
  const busy = start(['serve', '--config', config, '--port', '0'], { ...box.env, JEV_ROUTER_UI: String(taken) });
  const busyUrl = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(busy.out.stderr)?.[1], 'the second router');
  await waitFor(() => busy.out.stderr.includes("the live view can't listen"), 'the view error');
  assert.equal((await ask(busyUrl)).status, 200, 'routing goes on without the view');
  busy.child.kill('SIGTERM');
  assert.equal((await busy.done).code, 0);
  holder.close();

  const bad = await run(['serve', '--config', config, '--port', '0', '--ui', 'somewhere'], box.env);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--ui takes a port or host:port, got "somewhere"/);
});

test('serve --ui-token, else JEV_ROUTER_UI_TOKEN, puts the live view behind a token and prints the address that carries it', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'ui-token.json'), {}, { upstream: upstream.url });
  const token = fake('view-', 'token/', 'with?odd&chars');
  const serving = start(['serve', '--config', config, '--port', '0', '--ui', '0.0.0.0:0', '--ui-token', token], box.env);
  const shown = await waitFor(() => /live view on (http:\/\/127\.0\.0\.1:\d+\/)\?token=(\S+)\n/.exec(serving.out.stderr), 'the view');
  const [, view, carried] = shown;
  assert.equal(decodeURIComponent(carried), token, 'the address carries the token');
  assert.doesNotMatch(serving.out.stderr, /anyone who can reach that address/, 'a view behind a token gets no open-view warning');
  assert.equal((await fetch(view)).status, 401, 'no token, no page');
  const page = await fetch(`${view}?token=${carried}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('set-cookie') ?? '', /^jev-router-ui-\d+=.*; HttpOnly; SameSite=Strict; Path=\/$/);
  const url = /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1] ?? '';
  assert.equal((await ask(url)).status, 200);
  await waitFor(() => serving.out.stdout.includes('"event":"done"'), 'the done line');
  serving.child.kill('SIGTERM');
  assert.equal((await serving.done).code, 0);
  assert.ok(!serving.out.stdout.includes(token) && !serving.out.stdout.includes(carried), 'the token never reaches the log');

  const open = start(['serve', '--config', config, '--port', '0', '--ui', '0.0.0.0:0'], box.env);
  await waitFor(() => open.out.stderr.includes('anyone who can reach that address can watch routing decisions'), 'the open-view warning');
  const openView = /live view on (http:\/\/127\.0\.0\.1:\d+\/)\n/.exec(open.out.stderr)?.[1] ?? '';
  assert.equal((await fetch(openView)).status, 200, 'without a token the view stays as it was');
  open.child.kill('SIGTERM');
  assert.equal((await open.done).code, 0);

  const viewing = start(['ui', join(box.root, 'any.log'), '--port', '0'], { ...box.env, JEV_ROUTER_UI_TOKEN: token });
  const uiView = await waitFor(() => /open (http:\/\/127\.0\.0\.1:\d+\/)\?token=\S+\n/.exec(viewing.out.stderr)?.[1], 'the ui view');
  assert.equal((await fetch(uiView)).status, 401, 'jev-router ui takes JEV_ROUTER_UI_TOKEN too');
  assert.equal((await fetch(`${uiView}?token=${carried}`)).status, 200);
  viewing.child.kill('SIGTERM');
  assert.equal((await viewing.done).code, 0);
});

test('serve refuses to listen on a network address without a token, or on a taken port', async () => {
  const box = sandbox();
  const open = await run(['serve', '--host', '0.0.0.0', '--port', '0'], box.env);
  assert.equal(open.code, 1);
  assert.equal(open.stderr, 'jev-router: Refusing to listen on 0.0.0.0 without a token: set JEV_ROUTER_TOKEN.\n');
  const { port } = await runningRouter();
  const taken = await run(['serve', '--port', String(port)], box.env);
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, new RegExp(`^jev-router: cannot listen on 127\\.0\\.0\\.1:${port}: listen EADDRINUSE`));
});

test('launch claude starts a router for the session, hands the agent its args and env, and exits with its code', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const logFile = join(box.root, 'extra.log');
  const config = writeConfig(join(box.root, 'launch.json'), { logFile }, { upstream: upstream.url });
  const env = {
    ...box.env,
    JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT,
    FAKE_AGENT_REQUEST: '1',
    FAKE_AGENT_STDOUT: 'fake agent output\n',
    FAKE_AGENT_EXIT: '7',
    FAKE_CLIENT_KEY: CLIENT_KEY,
  };
  const result = await run(['launch', 'claude', '--config', config, '--port', '0', '--', '--config', 'x', 'fix the bug'], env);
  assert.equal(result.code, 7, result.stderr);
  assert.equal(result.stdout, 'fake agent output\n', "only the agent's own output reaches stdout");
  assert.match(
    result.stderr,
    /^jev-router: routing claude through http:\/\/127\.0\.0\.1:\d+ \(log: .*router\.log\)\n$/,
    'one line, before the agent starts',
  );

  const agent = box.agent();
  assert.deepEqual(agent.argv, ['--config', 'x', 'fix the bug'], 'everything after -- is the agent’s');
  const port = portOf(agent.env.ANTHROPIC_BASE_URL);
  assert.deepEqual(
    agent.env,
    {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000',
      ENABLE_TOOL_SEARCH: 'true',
    },
    'no API key, auth token or custom headers are set for the agent',
  );
  assert.equal(agent.health.version, VERSION);

  assert.equal(agent.request.status, 200);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].body.model, 'claude-sonnet-5');
  assert.equal(upstream.calls[0].headers['x-api-key'], CLIENT_KEY, "the agent's own login goes through");
  const log = join(box.state, 'jev-router', 'router.log');
  assert.deepEqual(logEvents(readFileSync(log, 'utf8')), ['config', 'warning', 'route', 'done'], 'the router logs to its file');
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(readFileSync(logFile, 'utf8'), readFileSync(log, 'utf8'), 'and to the config logFile');
  assert.equal(await isListening(port), false, 'the router stops with the agent');

  const loose = await run(['launch', 'claude', '--config', config, '--port', '0', '--resume', 'abc'], {
    ...env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000',
  });
  assert.equal(loose.code, 7);
  assert.deepEqual(box.agent().argv, ['--resume', 'abc'], 'the first argument that is not ours starts the agent’s');
  assert.equal(box.agent().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000', "the user's own compaction window stays");
});

test('launch claude adds the router token to the user’s custom headers, and the router accepts it', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'token.json'), { token: 'from-config' }, { upstream: upstream.url });
  const env = {
    ...box.env,
    JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT,
    FAKE_AGENT_REQUEST: '1',
    FAKE_CLIENT_KEY: CLIENT_KEY,
    ANTHROPIC_CUSTOM_HEADERS: 'x-team: blue\nx-jev-router-token: stale',
  };
  const fromEnv = await run(['launch', 'claude', '--config', config, '--port', '0'], { ...env, JEV_ROUTER_TOKEN: TOKEN });
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.equal(box.agent().env.ANTHROPIC_CUSTOM_HEADERS, `x-team: blue\nx-jev-router-token: ${TOKEN}`, 'the stale token line is replaced');
  assert.equal(box.agent().request.status, 200, 'the router took the token');
  assert.equal(upstream.calls[0].headers['x-team'], 'blue');
  assert.equal(upstream.calls[0].headers['x-jev-router-token'], undefined, 'the token stays with the router');

  const fromConfig = await run(['launch', 'claude', '--config', config, '--port', '0'], env);
  assert.equal(fromConfig.code, 0, fromConfig.stderr);
  assert.equal(box.agent().env.ANTHROPIC_CUSTOM_HEADERS, 'x-team: blue\nx-jev-router-token: from-config');
  assert.equal(box.agent().request.status, 200);
});

test('--env-file and JEV_ROUTER_ENV_FILE load the router keys first, set variables win, and launch keeps them from the agent', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'env-file.json'), {}, { upstream: upstream.url });
  const fileKey = fake('file-', 'anthropic-', 'DO-NOT-PRINT');
  const shellKey = fake('shell-', 'anthropic-', 'DO-NOT-PRINT');
  const fileToken = fake('file-', 'router-', 'token');
  const envFile = join(box.root, 'router.env');
  writeFileSync(envFile, `# the router's own keys\nANTHROPIC_API_KEY=${fileKey}\nexport JEV_ROUTER_TOKEN="${fileToken}"\n`);
  chmodSync(envFile, 0o600);

  const env = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT, FAKE_AGENT_REQUEST: '1', FAKE_CLIENT_KEY: CLIENT_KEY };
  // The plain-machine path: real keys from a file, and no proxy or sandbox variable anywhere.
  assert.deepEqual(
    Object.keys(env).filter((name) => /proxy|^SBX_/i.test(name)),
    [],
  );
  const launched = await run(['launch', 'claude', '--config', config, '--port', '0', '--env-file', envFile], env);
  assert.equal(launched.code, 0, launched.stderr);
  assert.doesNotMatch(launched.stderr, /chmod|reads only when it starts/, 'a private file with plain keys gets no warning');
  const agent = box.agent();
  assert.equal(agent.env.ANTHROPIC_API_KEY, undefined, "the file's key stays with the router");
  assert.equal(
    agent.env.ANTHROPIC_CUSTOM_HEADERS,
    `x-jev-router-token: ${fileToken}`,
    'the token from the file reaches the agent as its header',
  );
  assert.equal(agent.request.status, 200, 'the router took the token from the file');
  assert.equal(upstream.calls.at(-1)?.headers['x-api-key'], fileKey, 'and used the key from the file');

  const serving = start(['serve', '--config', config, '--port', '0'], {
    ...box.env,
    JEV_ROUTER_ENV_FILE: envFile,
    ANTHROPIC_API_KEY: shellKey,
  });
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CLIENT_KEY, 'x-jev-router-token': fileToken },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'Add a test' }] }),
  });
  await res.text();
  assert.equal(res.status, 200, 'JEV_ROUTER_ENV_FILE works like --env-file');
  assert.equal(upstream.calls.at(-1)?.headers['x-api-key'], shellKey, 'a variable that is set already wins over the file');
  serving.child.kill('SIGTERM');
  assert.equal((await serving.done).code, 0);
  for (const secret of [fileKey, shellKey])
    assert.ok(!`${serving.out.stdout}${serving.out.stderr}`.includes(secret), 'a key reached the output');

  const flagWins = await run(['env', 'claude', '--env-file', envFile], { ...box.env, JEV_ROUTER_ENV_FILE: join(box.root, 'missing.env') });
  assert.equal(flagWins.code, 0, '--env-file wins over JEV_ROUTER_ENV_FILE');
  assert.match(
    flagWins.stdout,
    new RegExp(`^export ANTHROPIC_CUSTOM_HEADERS='x-jev-router-token: ${fileToken}'$`, 'm'),
    'env reads the token from it',
  );

  // A launchd plist passes environment variables without a shell: a leading ~ is the home directory.
  mkdirSync(join(box.home, '.config', 'jev-router'), { recursive: true });
  copyFileSync(envFile, join(box.home, '.config', 'jev-router', 'env'));
  chmodSync(join(box.home, '.config', 'jev-router', 'env'), 0o600);
  const inHome = await run(['env', 'claude'], { ...box.env, JEV_ROUTER_ENV_FILE: '~/.config/jev-router/env' });
  assert.equal(inHome.code, 0, inHome.stderr);
  assert.match(inHome.stdout, new RegExp(`x-jev-router-token: ${fileToken}`));
});

test('with no env file named, serve, launch, env and doctor load $XDG_CONFIG_HOME/jev-router/env when it exists', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'standard.json'), {}, { upstream: upstream.url });
  const quiet = await run(['env', 'claude', '--port', '4555'], box.env);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(
    quiet.stderr,
    'jev-router: nothing answers at http://127.0.0.1:4555 yet. Start a router with: jev-router serve\n',
    'no file, no word',
  );

  const dir = join(box.config, 'jev-router');
  const standard = join(dir, 'env');
  mkdirSync(dir);
  const fileKey = fake('file-', 'anthropic-', 'DO-NOT-PRINT');
  const fileToken = fake('file-', 'router-', 'token');
  writeFileSync(standard, `ANTHROPIC_API_KEY=${fileKey}\nJEV_ROUTER_TOKEN=${fileToken}\nTYPESAFE_API_KEY=${JEV_KEY}\n`);
  chmodSync(standard, 0o600);

  const exported = await run(['env', 'claude', '--port', '4555'], box.env);
  assert.match(exported.stdout, new RegExp(`^export ANTHROPIC_CUSTOM_HEADERS='x-jev-router-token: ${fileToken}'$`, 'm'), 'env reads it');
  assert.doesNotMatch(exported.stderr, /env file|chmod/);

  const checked = await run(['doctor', '--config', config], { ...box.env, JEV_ROUTER_PORT: String(await freePort()) });
  assert.equal(checked.code, 0, checked.stdout);
  assert.match(
    checked.stdout,
    new RegExp(
      `^ {2}ok {3}env-file {2}${literal(standard)} \\(default location\\) sets ANTHROPIC_API_KEY, JEV_ROUTER_TOKEN, TYPESAFE_API_KEY$`,
      'm',
    ),
  );
  assert.match(checked.stdout, /^ {2}ok {3}jev {7}typesafe: TYPESAFE_API_KEY is set$/m);

  const env = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT, FAKE_AGENT_REQUEST: '1', FAKE_CLIENT_KEY: CLIENT_KEY };
  const launched = await run(['launch', 'claude', '--config', config, '--port', '0'], env);
  assert.equal(launched.code, 0, launched.stderr);
  const agent = box.agent();
  assert.equal(agent.env.ANTHROPIC_API_KEY, undefined, "the file's key stays with the router");
  assert.equal(
    agent.env.ANTHROPIC_CUSTOM_HEADERS,
    `x-jev-router-token: ${fileToken}`,
    'the token from the file reaches the agent as its header',
  );
  assert.equal(agent.request.status, 200, 'the router took the token from the file');
  assert.equal(upstream.calls.at(-1)?.headers['x-api-key'], fileKey, 'and used the key from the file');

  const serving = start(['serve', '--config', config, '--port', '0'], box.env);
  const url = await waitFor(() => /listening on (http:\/\/127\.0\.0\.1:\d+)\n/.exec(serving.out.stderr)?.[1], 'the router to listen');
  assert.equal((await ask(url)).status, 401, 'serve took the token from the file');
  serving.child.kill('SIGTERM');
  assert.equal((await serving.done).code, 0);
  assert.ok(!`${serving.out.stdout}${serving.out.stderr}${launched.stderr}${checked.stdout}`.includes(fileKey), 'a key reached the output');

  const off = await run(['env', 'claude', '--port', '4555'], { ...box.env, JEV_ROUTER_ENV_FILE: '/dev/null' });
  assert.equal(off.code, 0, off.stderr);
  assert.doesNotMatch(off.stdout, /x-jev-router-token/, 'JEV_ROUTER_ENV_FILE=/dev/null turns the env file off');

  const named = join(box.root, 'named.env');
  writeFileSync(named, 'JEV_ROUTER_PORT=4999\n');
  const other = await run(['env', 'claude', '--env-file', named], box.env);
  assert.match(other.stdout, /^export ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:4999$/m);
  assert.doesNotMatch(other.stdout, /x-jev-router-token/, 'a named file is read instead of the standard one');

  chmodSync(standard, 0o644);
  assert.match(
    (await run(['env', 'claude'], box.env)).stderr,
    /other users can read .*jev-router\/env \(mode 644\)/,
    'its mode is checked too',
  );
  if (process.getuid?.() !== 0) {
    chmodSync(standard, 0);
    const denied = await run(['env', 'claude'], box.env);
    assert.deepEqual(
      { code: denied.code, stderr: denied.stderr },
      { code: 1, stderr: `jev-router: Cannot read env file ${standard} (default location): permission denied\n` },
    );
  }
  rmSync(standard);
  mkdirSync(standard);
  const directory = await run(['doctor'], box.env);
  assert.equal(directory.code, 1);
  assert.match(directory.stdout, /^ {2}FAIL env-file {2}Cannot read env file .*jev-router\/env \(default location\): not a file$/m);
});

test('an env file that cannot be read stops the command, and one other users can read or that sets startup-only variables gets a warning', async () => {
  const box = sandbox();
  const missing = join(box.root, 'missing.env');
  const failed = await run(['serve', '--port', '0'], { ...box.env, JEV_ROUTER_ENV_FILE: missing });
  assert.deepEqual(
    { code: failed.code, stderr: failed.stderr },
    { code: 1, stderr: `jev-router: Cannot read env file ${missing} (JEV_ROUTER_ENV_FILE): no such file\n` },
  );
  const directory = await run(['launch', 'codex'], { ...box.env, JEV_ROUTER_ENV_FILE: box.root, JEV_ROUTER_CODEX_BIN: FAKE_AGENT });
  assert.equal(directory.code, 1);
  assert.match(directory.stderr, /Cannot read env file .* \(JEV_ROUTER_ENV_FILE\): not a file/);
  // Node 22 and 24 check the file of an --env-file anywhere on their own command line, script
  // arguments included, and stop with their own message before jev-router runs. They don't load it.
  for (const args of [['--env-file', missing], [`--env-file=${missing}`]]) {
    const flagged = await run(['launch', 'codex', ...args], { ...box.env, JEV_ROUTER_CODEX_BIN: FAKE_AGENT });
    assert.notEqual(flagged.code, 0);
    assert.ok(flagged.stderr.includes(missing), flagged.stderr);
  }
  assert.ok(!existsSync(box.report), 'the agent never started');

  const shared = join(box.root, 'shared.env');
  writeFileSync(shared, 'JEV_ROUTER_PORT=4567\nNODE_OPTIONS=--no-warnings\nNODE_USE_ENV_PROXY=1\nhttps_proxy=http://proxy.example:3128\n');
  chmodSync(shared, 0o664);
  const loose = await run(['env', 'claude', '--env-file', shared], box.env);
  assert.equal(loose.code, 0, loose.stderr);
  assert.match(loose.stdout, /^export ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:4567$/m, 'the file set the port');
  const warnings = loose.stderr.split('\n').filter((line) => line.includes(shared));
  assert.deepEqual(warnings, [
    `jev-router: other users can read and change ${shared} (mode 664), which holds API keys. Run: chmod 600 ${shared}`,
    `jev-router: NODE_USE_ENV_PROXY, https_proxy in ${shared} have no effect: Node reads them only when it starts. Set them where jev-router is started instead.`,
  ]);
  chmodSync(shared, 0o644);
  assert.match((await run(['env', 'claude', '--env-file', shared], box.env)).stderr, /other users can read .*shared\.env \(mode 644\)/);
});

/**
 * Follows a live view's event stream.
 * @param {string} view the view's page URL
 */
async function follow(view) {
  const res = await fetch(`${view}events`);
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const decoder = new TextDecoder();
  const seen = { text: '' };
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      seen.text += decoder.decode(value, { stream: true });
    }
  })();
  return { seen, stop: () => reader.cancel().catch(() => undefined) };
}

test('launch --ui serves the live view of a router it starts, before the agent starts, and says why there is none for one it reuses', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'launch-ui.json'), {}, { upstream: upstream.url });
  const env = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT, FAKE_AGENT_WAIT: '1', FAKE_AGENT_REQUEST: '1', FAKE_CLIENT_KEY: CLIENT_KEY };
  const launching = start(['launch', 'claude', '--config', config, '--port', '0', '--ui', '127.0.0.1:0'], env);
  await waitFor(() => existsSync(box.report), 'the agent to start');
  assert.match(
    launching.out.stderr,
    /^jev-router: routing claude through http:\/\/127\.0\.0\.1:\d+ \(log: .*\)\njev-router: live view on http:\/\/127\.0\.0\.1:\d+\/\n$/,
    'the view is up before the agent starts',
  );
  const view = /live view on (\S+)\n/.exec(launching.out.stderr)?.[1] ?? '';
  const events = await follow(view);
  await waitFor(() => events.seen.text.includes('"event":"route"') && events.seen.text.includes('"event":"done"'), "the agent's request");
  assert.match(events.seen.text, /"event":"config"/, 'with the config the router started with');
  await events.stop();
  launching.child.kill('SIGHUP');
  assert.equal((await launching.done).code, 42);
  assert.equal(await isListening(portOf(view)), false, 'the view stops with the session');

  const { port } = await runningRouter();
  const plain = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT };
  const reused = await run(['launch', 'claude', '--port', String(port), '--ui', '127.0.0.1:0'], plain);
  assert.equal(reused.code, 0, reused.stderr);
  assert.match(reused.stderr, /--ui serves a live view only for a router that launch starts\. .*jev-router ui\n$/);
  assert.doesNotMatch(reused.stderr, /live view on http/);
  const quiet = await run(['launch', 'claude', '--port', String(port)], { ...plain, JEV_ROUTER_UI: '127.0.0.1:0' });
  assert.equal(
    quiet.stderr,
    `jev-router: reusing the jev-router ${VERSION} at http://127.0.0.1:${port}\n`,
    'JEV_ROUTER_UI alone adds no hint',
  );
  const bad = await run(['launch', 'claude', '--port', String(port), '--ui', 'nowhere'], plain);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--ui takes a port or host:port, got "nowhere"/);
});

test('launch reuses a router that already answers on the port, and leaves it running', async () => {
  const box = sandbox();
  const { url, port } = await runningRouter();
  const result = await run(['launch', 'claude', '--port', String(port)], { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, `jev-router: reusing the jev-router ${VERSION} at http://127.0.0.1:${port}\n`);
  assert.equal(box.agent().env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
  assert.equal((await healthz(url)).ok, true, 'the shared router keeps running');
  assert.ok(!existsSync(join(box.state, 'jev-router')), 'no router of its own, so no log of its own');
});

test("a second launch doesn't lean on another session's router, which stops with that session", async () => {
  const box = sandbox();
  const port = await freePort();
  const env = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT };
  const first = start(['launch', 'claude', '--port', String(port)], { ...env, FAKE_AGENT_WAIT: '1' });
  await waitFor(() => existsSync(box.report), 'the first agent to start');
  assert.equal(portOf(box.agent().env.ANTHROPIC_BASE_URL), port);
  const marker = join(box.state, 'jev-router', `launch-${port}.pid`);
  assert.equal(readFileSync(marker, 'utf8'), String(first.child.pid));

  const report = join(box.root, 'second.json');
  const second = await run(['launch', 'claude', '--port', String(port)], { ...env, FAKE_AGENT_REPORT: report });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /^jev-router: routing claude through /);
  assert.notEqual(portOf(JSON.parse(readFileSync(report, 'utf8')).env.ANTHROPIC_BASE_URL), port, 'its own router, on a free port');

  first.child.kill('SIGHUP');
  assert.equal((await first.done).code, 42);
  assert.ok(!existsSync(marker), 'the marker goes with its router');

  // A marker left behind by a launch that died doesn't stop a router on that port from being shared.
  const { port: shared } = await runningRouter();
  writeFileSync(join(box.state, 'jev-router', `launch-${shared}.pid`), '2147483647');
  assert.match((await run(['launch', 'claude', '--port', String(shared)], env)).stderr, /^jev-router: reusing the jev-router/);
});

test('launch moves to a free port when something else holds the configured one', async () => {
  const box = sandbox();
  const other = http.createServer((_req, res) => res.end('<html>a dev server</html>'));
  servers.push(other);
  const taken = portOf(await listen(other));
  const result = await run(['launch', 'claude', '--port', String(taken)], { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT });
  assert.equal(result.code, 0, result.stderr);
  const agent = box.agent();
  assert.notEqual(portOf(agent.env.ANTHROPIC_BASE_URL), taken);
  assert.equal(agent.health.version, VERSION, 'the agent reaches the router on its new port');
});

test('launch finds the agent on PATH, and exits 127 when it is missing or cannot start', async () => {
  const box = sandbox();
  const missing = await run(['launch', 'claude', '--port', '0'], box.env);
  assert.deepEqual(missing, {
    code: 127,
    signal: null,
    stdout: '',
    stderr: 'jev-router: cannot find claude. Install it, or set JEV_ROUTER_CLAUDE_BIN to its path.\n',
  });
  const override = await run(['launch', 'codex', '--port', '0'], { ...box.env, JEV_ROUTER_CODEX_BIN: join(box.root, 'no-codex') });
  assert.equal(override.code, 127);
  assert.match(override.stderr, /cannot find .*no-codex\. Install it, or set JEV_ROUTER_CODEX_BIN to its path\.\n$/);

  const broken = join(box.root, 'broken-agent');
  writeFileSync(broken, '#!/nonexistent/interpreter\n');
  chmodSync(broken, 0o755);
  const cannot = await run(['launch', 'claude', '--port', '0'], { ...box.env, JEV_ROUTER_CLAUDE_BIN: broken });
  assert.equal(cannot.code, 127);
  assert.match(cannot.stderr, /jev-router: cannot run .*broken-agent: spawn .*ENOENT\n$/);

  copyFileSync(FAKE_AGENT, join(box.bin, 'claude'));
  chmodSync(join(box.bin, 'claude'), 0o755);
  const found = await run(['launch', 'claude', '--port', '0', 'hello'], box.env);
  assert.equal(found.code, 0, found.stderr);
  assert.deepEqual(box.agent().argv, ['hello']);

  const bad = writeConfig(join(box.root, 'bad.json'), { defaultTier: 'cheapest' });
  rmSync(box.report);
  const invalid = await run(['launch', 'claude', '--config', bad], box.env);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /^jev-router: Invalid router config:\n {2}- defaultTier "cheapest" is not one of tiers/);
  assert.ok(!existsSync(box.report), 'the agent never started');
});

test('while the agent runs, Ctrl-C is left to it, and SIGHUP and SIGTERM are forwarded', async () => {
  const box = sandbox();
  const env = { ...box.env, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT, FAKE_AGENT_WAIT: '1' };
  const hup = start(['launch', 'claude', '--port', '0'], env);
  await waitFor(() => existsSync(box.report), 'the agent to start');
  hup.child.kill('SIGINT');
  await sleep(300);
  assert.equal(hup.child.exitCode, null, 'SIGINT did not stop the launcher');
  hup.child.kill('SIGHUP');
  assert.equal((await hup.done).code, 42, 'the agent got SIGHUP, and its exit code came back');
  assert.equal(await isListening(portOf(box.agent().env.ANTHROPIC_BASE_URL)), false);

  rmSync(box.report);
  const term = start(['launch', 'claude', '--port', '0'], env);
  await waitFor(() => existsSync(box.report), 'the agent to start');
  term.child.kill('SIGTERM');
  assert.equal((await term.done).code, 128 + 15, 'the agent died of SIGTERM, which is exit code 128 + 15');
});

test('launch codex writes the profile, starts codex --profile jev, and routes through it', async () => {
  const box = sandbox();
  const upstream = await mockUpstream();
  const config = writeConfig(join(box.root, 'codex.json'), {}, { upstream: upstream.url });
  /** @type {Record<string, string>} */
  const env = { ...box.env, JEV_ROUTER_CODEX_BIN: FAKE_AGENT, FAKE_AGENT_REQUEST: '1', FAKE_AGENT_EXIT: '3', JEV_ROUTER_TOKEN: TOKEN };
  const result = await run(['launch', 'codex', '--config', config, '--port', '0', 'exec', 'fix the tests'], env);
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stdout, '');
  const agent = box.agent();
  assert.deepEqual(agent.argv, ['--profile', 'jev', 'exec', 'fix the tests']);
  assert.equal(agent.env.ANTHROPIC_BASE_URL, undefined, 'Codex gets the router from its profile');

  const path = join(box.codex, 'jev.config.toml');
  const profile = readFileSync(path, 'utf8');
  const baseUrl = JSON.parse(/^base_url = (".*")$/m.exec(profile)?.[1] ?? '""');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(JSON.parse(/^model_catalog_json = (".*")$/m.exec(profile)?.[1] ?? '""'), CODEX_MODELS);
  assert.ok(existsSync(CODEX_MODELS));
  assert.ok(profile.includes(`http_headers = { "x-jev-router-token" = ${JSON.stringify(TOKEN)} }`));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(agent.health.version, VERSION);
  assert.equal(agent.request.status, 200, 'the router took the token from the profile');
  assert.equal(upstream.calls[0].url, '/v1/responses');
  assert.equal(upstream.calls[0].body.model, 'kimi-k2.7-code');
  assert.equal(await isListening(portOf(baseUrl)), false);

  const { CODEX_HOME, ...noCodexHome } = env;
  assert.equal((await run(['launch', 'codex', '--config', config, '--port', '0'], noCodexHome)).code, 3);
  assert.ok(existsSync(join(box.home, '.codex', 'jev.config.toml')), 'without CODEX_HOME, ~/.codex');
});

test('launch codex keeps an edited profile with one note, follows the router in its own, and --force rewrites', async () => {
  const box = sandbox();
  const { port } = await runningRouter();
  const env = { ...box.env, JEV_ROUTER_CODEX_BIN: FAKE_AGENT };
  const path = join(box.codex, 'jev.config.toml');
  const launchCodex = (/** @type {string[]} */ ...args) => run(['launch', 'codex', '--port', String(port), ...args], env);

  assert.equal((await launchCodex()).code, 0);
  const generated = readFileSync(path, 'utf8');
  assert.equal((await launchCodex()).stderr.split('\n').filter(Boolean).length, 1, 'the same profile again: no note');

  const edited = generated.replace('web_search = "disabled"', 'web_search = "live"');
  writeFileSync(path, edited);
  const kept = await launchCodex();
  assert.equal(kept.code, 0, kept.stderr);
  assert.equal(readFileSync(path, 'utf8'), edited);
  const notes = kept.stderr.split('\n').filter((line) => line.includes('kept'));
  assert.deepEqual(notes, [
    `jev-router: kept ${path} because it was edited. Pass --force to replace it with the profile for http://127.0.0.1:${port}/v1.`,
  ]);

  const unreadable = generated.replace(/^(base_url = .*)$/m, '$1\nhttp_headers = { "x-jev-router-token" = "\\q" }');
  writeFileSync(path, unreadable);
  assert.match((await launchCodex()).stderr, /kept .* because it was edited/, 'a string it cannot read back is an edit too');
  assert.equal(readFileSync(path, 'utf8'), unreadable);

  assert.equal((await launchCodex('--force')).code, 0);
  assert.equal(readFileSync(path, 'utf8'), generated);

  // Its own, unedited profile follows the router to another port or token without a note.
  const moved = await run(['launch', 'codex', '--port', '0'], { ...env, JEV_ROUTER_TOKEN: TOKEN });
  assert.equal(moved.code, 0, moved.stderr);
  assert.doesNotMatch(moved.stderr, /kept/);
  assert.notEqual(readFileSync(path, 'utf8'), generated);
  assert.equal(box.agent().health.version, VERSION, 'Codex reaches the new router');
});
