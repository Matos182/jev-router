// Tests for `jev-router setup` and `jev-router uninstall`, through the real bin/jev-router.mjs in a
// child process (see harness.mjs). test/fakes/fake-service.mjs stands in for launchctl and
// systemctl and starts the router from the file setup installed, so each test proves that file
// works; test/fakes/fake-npm.mjs stands in for npm; test/fakes/jev-redirect.mjs sends the packaged
// configs' Jev channels to a local mock. Nothing touches the real HOME, a service manager or the network.

import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/router.mjs';
import {
  ANTHROPIC_FABLE_CONFIG,
  ANTHROPIC_ONLY_CONFIG,
  ask,
  BIN,
  DEFAULT_CONFIG,
  FAKE_AGENT,
  fake,
  freePort,
  healthz,
  isListening,
  mock,
  run,
  runningRouter,
  sandbox,
  start,
  waitFor,
} from './harness.mjs';
import { jevOptionsAnswer, json } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_SERVICE = fileURLToPath(new URL('./fakes/fake-service.mjs', import.meta.url));
const FAKE_NPM = fileURLToPath(new URL('./fakes/fake-npm.mjs', import.meta.url));
const REDIRECT = fileURLToPath(new URL('./fakes/jev-redirect.mjs', import.meta.url));
const GOOD = fake('good-', 'jev-key-', 'DO-NOT-PRINT');
const BAD = fake('bad-', 'jev-key-', 'DO-NOT-PRINT');
const OLLAMA = fake('ol-', 'setup-', 'DO-NOT-PRINT');
const ROUTER_TOKEN = fake('router-', 'setup-', 'token');

/** Runs once at the next Jev call, while setup checks the key: a test's way to act in the middle of setup. */
/** @type {(() => void) | undefined} */
let duringKeyCheck;
/** One System One mock for every test: a key that holds "good" gets an answer, any other a 401. */
const jev = await mock((call, res) => {
  duringKeyCheck?.();
  duringKeyCheck = undefined;
  return String(call.headers.authorization).includes('good-')
    ? json(res, 200, jevOptionsAnswer({ option: 'routine', model: 'jev-1.13.0-mock' }))
    : json(res, 401, { detail: { message: 'invalid key' } });
});

/**
 * A sandbox for setup: the fake service tools and jev-router on PATH, a free port for the router
 * and one for its live view, and the mock Jev behind the packaged configs' channels.
 * @param {{ tools?: string[], installed?: boolean }} [options] which fakes to put on PATH, and whether jev-router is there
 */
async function setupBox({ tools = ['launchctl', 'systemctl'], installed = true } = {}) {
  const box = sandbox();
  for (const tool of tools) {
    copyFileSync(tool === 'npm' ? FAKE_NPM : FAKE_SERVICE, join(box.bin, tool));
    chmodSync(join(box.bin, tool), 0o755);
  }
  if (installed) symlinkSync(BIN, join(box.bin, 'jev-router'));
  const port = await freePort();
  const ui = await freePort();
  const log = join(box.root, 'service.log');
  const env = { ...box.env, FAKE_SERVICE_LOG: log, FAKE_JEV_URL: jev.url, JEV_ROUTER_PORT: String(port), JEV_ROUTER_UI: String(ui) };
  return {
    ...box,
    env,
    port,
    url: `http://127.0.0.1:${port}`,
    configFile: join(box.config, 'jev-router', 'config.json'),
    envFile: join(box.config, 'jev-router', 'env'),
    manifest: join(box.config, 'jev-router', 'setup.json'),
    settings: join(box.home, '.claude', 'settings.json'),
    unit: join(box.home, '.config', 'systemd', 'user', 'jev-router.service'), // where the user manager looks
    plist: join(box.home, 'Library', 'LaunchAgents', 'io.github.dirien.jev-router.plist'),
    /** @returns {Array<{ tool: string, args: string[] }>} every call to the fake service tools */
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

/**
 * Runs setup with the mock Jev in place of the packaged channels' hosts.
 * @param {{ env: Record<string, string> }} box
 * @param {string[]} args
 * @param {{ input?: string, env?: Record<string, string>, bin?: string }} [options]
 */
const setup = (box, args, { input, env = {}, bin } = {}) =>
  run(['setup', ...args], { ...box.env, ...env }, { input, node: ['--import', REDIRECT], bin });

/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
/** @param {string} file */
const modeOf = (file) => statSync(file).mode & 0o777;

test('setup asks for the models and a Jev key, checks the key, runs the router as a systemd unit, and points Claude Code at it', async () => {
  const box = await setupBox();
  const calls = jev.calls.length;
  const result = await setup(box, ['--service', 'systemd'], { input: `\n${GOOD}\n\n` });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  for (const text of [
    'Which models should Claude Code use?\n  1. Claude only: Haiku 4.5, Sonnet 5 and Opus 5.5. You need a Jev key.\n',
    'Choose 1, 2 or 3 [1]: \n',
    'TypeSafe API key (press Enter to use an OpenRouter key instead): \n',
    'Checking the TypeSafe key with one Jev call (about $0.00003)... it works (typesafe answered in ',
    'Start jev-router in the background when you log in, and send every Claude Code session through it? [Y/n] \n',
    `Waiting for the router at ${box.url}... it answers.\n`,
    "Restart any Claude Code session that's already running",
    'Start Claude Code as usual: claude\nCheck it: jev-router doctor\nUndo it: jev-router uninstall\n',
    'To keep it running while you are logged out, run: loginctl enable-linger\n',
    `Codex: put OLLAMA_API_KEY and OPENAI_API_KEY in ${box.envFile}, run jev-router setup again to restart the router with them,`,
    `Saved JEV_ROUTER_PORT=${box.port} there too, so every jev-router command finds the router.\n`,
  ])
    assert.ok(result.stderr.includes(text), text);
  assert.ok(!result.stderr.includes(GOOD), 'the key is never printed');
  assert.doesNotMatch(result.stderr, /\n\n\n/, 'one blank line between parts');
  assert.equal(jev.calls.length, calls + 1, 'one Jev call');
  assert.equal(jev.calls.at(-1)?.headers.authorization, `Bearer ${GOOD}`);

  assert.equal(readFileSync(box.configFile, 'utf8'), readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'), 'the default is Claude only');
  assert.equal(modeOf(box.configFile), 0o600);
  assert.equal(modeOf(join(box.config, 'jev-router')), 0o700);
  assert.match(readFileSync(box.envFile, 'utf8'), new RegExp(`^TYPESAFE_API_KEY=${GOOD}\nJEV_ROUTER_PORT=${box.port}$`, 'm'));
  assert.equal(modeOf(box.envFile), 0o600);

  assert.deepEqual(
    box.calls().map((call) => `${call.tool} ${call.args.join(' ')}`),
    [
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable jev-router',
      'systemctl --user restart jev-router',
    ],
  );
  const unit = readFileSync(box.unit, 'utf8');
  assert.match(unit, /^# Written by `jev-router setup`/);
  assert.equal(
    /^ExecStart=(.*)$/m.exec(unit)?.[1],
    `/usr/bin/env jev-router serve --ui ${box.env.JEV_ROUTER_UI} --config "${box.configFile}" --env-file "${box.envFile}" --log-file "${join(box.state, 'jev-router', 'router.log')}"`,
    'the port comes from the env file, like every other command reads it',
  );
  assert.match(unit, new RegExp(`^Environment="PATH=${box.bin}:`, 'm'), 'PATH starts with where jev-router is');
  const health = await healthz(box.url);
  assert.equal(health.version, VERSION, 'the unit started a router');
  assert.equal((await fetch(`http://127.0.0.1:${box.env.JEV_ROUTER_UI}/`)).status, 200, 'with its live view');

  assert.deepEqual(readJson(box.settings), {
    env: {
      ANTHROPIC_BASE_URL: box.url,
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000',
      ENABLE_TOOL_SEARCH: 'true',
    },
  });
  assert.equal(modeOf(box.settings), 0o600);
  const manifest = readFileSync(box.manifest, 'utf8');
  assert.ok(!manifest.includes(GOOD), 'the manifest holds no key');
  assert.equal(readJson(box.manifest).service.file, box.unit);

  const { JEV_ROUTER_PORT, ...shell } = box.env; // a new shell: the port is only in the env file now
  const doctor = await run(['doctor'], shell);
  assert.equal(doctor.code, 0, doctor.stdout);
  assert.match(doctor.stdout, new RegExp(`^ {2}ok {3}service {3}systemd user unit ${box.unit}; the router answers at ${box.url}$`, 'm'));
  assert.match(doctor.stdout, /Ready\. Start Claude Code as usual: claude\n$/);
  assert.match((await run(['env', 'claude'], shell)).stdout, new RegExp(`^export ANTHROPIC_BASE_URL=${box.url}$`, 'm'), 'env finds it too');
});

test('setup --yes takes the keys from the environment, runs a launchd agent, and merges into existing settings with a backup', async () => {
  const box = await setupBox();
  mkdirSync(join(box.home, '.claude'));
  const before =
    '{\n    "model": "opus",\n    "env": { "FOO": "bar", "ENABLE_TOOL_SEARCH": "auto" },\n    "permissions": { "allow": [] }\n}\n';
  writeFileSync(box.settings, before);
  chmodSync(box.settings, 0o640);
  mkdirSync(join(box.config, 'jev-router'));
  writeFileSync(box.envFile, `# my router\nJEV_ROUTER_TOKEN=${ROUTER_TOKEN}\n`);
  chmodSync(box.envFile, 0o644);
  const env = { TYPESAFE_API_KEY: GOOD, OLLAMA_API_KEY: OLLAMA };
  const result = await setup(box, ['--yes', '--service', 'launchd', '--models', 'ollama'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /^Models: Ollama Cloud's glm-5\.3-flash for quick work, and Claude for the rest\.$/m);
  assert.match(result.stderr, /^note: other users can read .*jev-router\/env \(mode 644\)/m, 'the loose mode is named');
  for (const secret of [GOOD, OLLAMA, ROUTER_TOKEN]) assert.ok(!result.stderr.includes(secret), 'a secret reached the output');
  assert.equal(readFileSync(box.configFile, 'utf8'), readFileSync(DEFAULT_CONFIG, 'utf8'));
  assert.equal(
    readFileSync(box.envFile, 'utf8'),
    `# my router\nJEV_ROUTER_TOKEN=${ROUTER_TOKEN}\nTYPESAFE_API_KEY=${GOOD}\nOLLAMA_API_KEY=${OLLAMA}\nJEV_ROUTER_PORT=${box.port}\n`,
    'its lines stay, the keys go at the end',
  );
  assert.equal(modeOf(box.envFile), 0o600, 'and only its owner can read it now');

  const uid = String(process.getuid?.());
  assert.deepEqual(box.calls(), [
    { tool: 'launchctl', args: ['print', `gui/${uid}`] },
    { tool: 'launchctl', args: ['bootout', `gui/${uid}/io.github.dirien.jev-router`] },
    { tool: 'launchctl', args: ['bootstrap', `gui/${uid}`, box.plist] },
  ]);
  const plist = readFileSync(box.plist, 'utf8');
  assert.match(
    plist,
    new RegExp(`<string>${box.configFile}</string>\\n {4}<string>--env-file</string>\\n {4}<string>${box.envFile}</string>`),
  );
  assert.match(plist, new RegExp(`<key>StandardErrorPath</key>\\n {2}<string>${box.home}/Library/Logs/jev-router/router.err.log</string>`));
  assert.ok(existsSync(join(box.home, 'Library', 'Logs', 'jev-router')), 'launchd needs the log directory to exist');
  assert.equal((await ask(box.url)).status, 401, 'the service took the router token from the env file');

  const settings = readFileSync(box.settings, 'utf8');
  assert.deepEqual(JSON.parse(settings), {
    model: 'opus',
    env: {
      FOO: 'bar',
      ENABLE_TOOL_SEARCH: 'auto',
      ANTHROPIC_BASE_URL: box.url,
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000',
      ANTHROPIC_CUSTOM_HEADERS: `x-jev-router-token: ${ROUTER_TOKEN}`,
    },
    permissions: { allow: [] },
  });
  assert.deepEqual(Object.keys(JSON.parse(settings)), ['model', 'env', 'permissions'], 'the keys keep their order');
  assert.ok(settings.startsWith('{\n  "model": "opus",\n  "env": {\n    "FOO": "bar",'), '2-space indentation');
  assert.ok(settings.endsWith('}\n'));
  assert.equal(modeOf(box.settings), 0o600, 'with the router token in it, only its owner can read it');
  assert.equal(readFileSync(`${box.settings}.jev-router.bak`, 'utf8'), before, 'the old file is kept');
  assert.equal(modeOf(`${box.settings}.jev-router.bak`), 0o600, 'and only its owner can read the backup');
  const manifest = readFileSync(box.manifest, 'utf8');
  assert.ok(!manifest.includes(ROUTER_TOKEN), 'the router token stays in settings.json');
  assert.equal(readJson(box.manifest).claude.tokenHeader, 'created');

  const again = await setup(box, ['--yes', '--service', 'none', '--models', 'ollama']);
  assert.equal(again.code, 0, 'the keys are in the env file now');
  assert.match(again.stderr, /The launchd agent from an earlier setup is still installed .*; jev-router uninstall removes it\.\n/);
  const empty = await setupBox();
  const none = await setup(empty, ['--yes', '--models', 'ollama']);
  assert.equal(none.code, 1);
  assert.match(
    none.stderr,
    /setup --yes takes the keys from the environment\. Set TYPESAFE_API_KEY or OPENROUTER_API_KEY for Jev and OLLAMA_API_KEY for Claude Code's fast tier\.\n$/,
  );
  assert.ok(!existsSync(join(empty.config, 'jev-router')), 'nothing was written');
});

test('setup on a config whose Jev channels are all local asks for no Jev key, with or without --yes', async () => {
  for (const args of [['--yes'], []]) {
    const box = await setupBox();
    mkdirSync(join(box.config, 'jev-router'));
    const local = JSON.parse(readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'));
    local.jev.channels = [{ name: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'nimble' }];
    writeFileSync(box.configFile, JSON.stringify(local));
    const result = await setup(box, [...args, '--service', 'none'], { input: '\n' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      /^Jev decides which model each message needs\. It runs on ollama at http:\/\/127\.0\.0\.1:11434, which needs no key\.$/m,
    );
    assert.doesNotMatch(result.stderr, /API key|Checking the/, `${args.join(' ') || 'interactive'}: no Jev key is asked for or checked`);
    assert.doesNotMatch(readFileSync(box.envFile, 'utf8'), /API_KEY/);
  }
});

test('setup keeps an existing config and a saved key, and a second run restarts the service it installed', async () => {
  const box = await setupBox();
  mkdirSync(join(box.config, 'jev-router'));
  const claudeOnly = JSON.parse(readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'));
  claudeOnly.jev.channels = [{ name: 'mock', baseUrl: jev.url, model: 'jev-1.13.0', keyEnv: 'MOCK_JEV_KEY', timeoutMs: 1000 }];
  writeFileSync(box.configFile, JSON.stringify(claudeOnly));
  const saved = `MOCK_JEV_KEY=${GOOD}\nJEV_ROUTER_PORT=${box.port}\n`;
  writeFileSync(box.envFile, saved, { mode: 0o600 });
  const first = await setup(box, ['--service', 'systemd', '--models', 'ollama'], { input: '\n\n' });
  assert.equal(first.code, 0, first.stderr);
  assert.match(
    first.stderr,
    new RegExp(
      `^Config: ${box.configFile} \\(user config\\), kept as it is: it isn't one of the packaged configs\\. ` +
        'To start over from the packaged ollama config, run jev-router init --models ollama --force, then setup again\\.$',
      'm',
    ),
  );
  assert.doesNotMatch(first.stderr, /Which models/);
  assert.match(first.stderr, /^MOCK_JEV_KEY API key \[saved; press Enter to keep it\]: $/m);
  assert.match(first.stderr, new RegExp(`^Kept the keys in ${box.envFile}\\.$`, 'm'));
  assert.equal(readFileSync(box.envFile, 'utf8'), saved, 'the env file is untouched');
  const pid = readFileSync(join(box.root, 'fake-service.pid'), 'utf8');

  const second = await setup(box, ['--service', 'systemd'], { input: '\n\n' });
  assert.equal(second.code, 0, second.stderr);
  assert.ok(
    second.stderr.includes(
      "kept as it is: it isn't one of the packaged configs. To start over from a packaged one, run jev-router init --models claude|fable|ollama --force, then setup again.\n",
    ),
    'the way back, without --models too',
  );
  assert.notEqual(readFileSync(join(box.root, 'fake-service.pid'), 'utf8'), pid, 'the router was restarted');
  assert.match(second.stderr, /point at the router already\./);
  assert.doesNotMatch(second.stderr, /Restart any Claude Code session/, 'nothing changed, so nothing to restart');
  assert.equal(box.calls().filter((call) => call.args[1] === 'restart').length, 2);
  assert.equal((await healthz(box.url)).ok, true);
});

/**
 * The tiers of the config the service's router started with, from the newest `config` line in its log.
 * @param {{ state: string }} box
 */
async function startedTiers(box) {
  const log = join(box.state, 'jev-router', 'router.log');
  /** @returns {string[] | undefined} */
  const newest = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .findLast((entry) => entry.event === 'config')?.tiers
      : undefined;
  await waitFor(() => newest() !== undefined, 'the config line');
  return newest();
}

test('setup --models fable writes the Fable config, and a second run switches an unchanged packaged config or keeps it on Enter', async () => {
  const box = await setupBox();
  const fable = await setup(box, ['--yes', '--service', 'systemd', '--models', 'fable'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(fable.code, 0, fable.stderr);
  assert.match(fable.stderr, /^Models: Claude only, with Fable 5\.1 for deep work: Haiku 4\.5, Sonnet 5, Opus 5\.5 and Fable 5\.1\.$/m);
  assert.match(fable.stderr, new RegExp(`^Wrote ${box.configFile} \\(Claude only, with Fable 5\\.1 for deep work: `, 'm'));
  assert.equal(readFileSync(box.configFile, 'utf8'), readFileSync(ANTHROPIC_FABLE_CONFIG, 'utf8'));
  assert.deepEqual(await startedTiers(box), ['fast', 'balanced', 'frontier', 'max'], 'the service runs it');

  const kept = await setup(box, ['--service', 'systemd'], { input: '\n\n\n' });
  assert.equal(kept.code, 0, kept.stderr);
  assert.ok(kept.stderr.includes('Which models should Claude Code use? Enter keeps the ones you have.\n'), kept.stderr);
  assert.ok(
    kept.stderr.includes(
      '  2. Claude only, with Fable 5.1 for deep work: Haiku 4.5, Sonnet 5, Opus 5.5 and Fable 5.1. You need a Jev key.\n',
    ),
  );
  assert.ok(kept.stderr.includes('Choose 1, 2 or 3 [2]: \n'), 'Enter keeps the Fable config');
  assert.match(kept.stderr, new RegExp(`^Kept ${box.configFile}\\.$`, 'm'));
  assert.equal(readFileSync(box.configFile, 'utf8'), readFileSync(ANTHROPIC_FABLE_CONFIG, 'utf8'));

  const switched = await setup(box, ['--service', 'systemd'], { input: '1\n\n\n' });
  assert.equal(switched.code, 0, switched.stderr);
  assert.match(switched.stderr, new RegExp(`^Switched ${box.configFile} from Claude with Fable 5\\.1 to Claude only\\.$`, 'm'));
  assert.equal(readFileSync(box.configFile, 'utf8'), readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'));
  assert.deepEqual(await startedTiers(box), ['fast', 'balanced', 'frontier'], 'the restarted service runs the new one');

  const back = await setup(box, ['--yes', '--service', 'systemd', '--models', 'fable']);
  assert.equal(back.code, 0, back.stderr);
  assert.match(back.stderr, new RegExp(`^Switched ${box.configFile} from Claude only to Claude with Fable 5\\.1\\.$`, 'm'));
  const same = await setup(box, ['--yes', '--service', 'systemd']);
  assert.match(same.stderr, new RegExp(`^Kept ${box.configFile}\\.$`, 'm'), '--yes keeps the models');
  assert.equal(readJson(box.manifest).files.config, box.configFile);

  const mine = join(box.root, 'mine.json');
  copyFileSync(ANTHROPIC_FABLE_CONFIG, mine);
  const named = await setup(box, ['--yes', '--service', 'none', '--models', 'claude'], { env: { JEV_ROUTER_CONFIG: mine } });
  assert.equal(named.code, 0, named.stderr);
  assert.match(
    named.stderr,
    /^Config: .*mine\.json \(JEV_ROUTER_CONFIG\), kept as it is; --models doesn't change a config that JEV_ROUTER_CONFIG names\.$/m,
  );
  assert.equal(readFileSync(mine, 'utf8'), readFileSync(ANTHROPIC_FABLE_CONFIG, 'utf8'));
});

test("setup never writes into jev-router's own files, keeps an edit made while it runs, and says a running router keeps its models", async () => {
  const linked = await setupBox();
  mkdirSync(join(linked.config, 'jev-router'));
  symlinkSync(ANTHROPIC_ONLY_CONFIG, linked.configFile);
  const packagedText = readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8');
  const kept = await setup(linked, ['--yes', '--service', 'none', '--models', 'fable'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(kept.code, 0, kept.stderr);
  assert.ok(
    kept.stderr.includes(
      `kept as it is: it leads into jev-router's own files (${realpathSync(ANTHROPIC_ONLY_CONFIG)}), which setup never changes. ` +
        `To pick models, remove it (rm ${linked.configFile}), then run setup again.\n`,
    ),
    kept.stderr,
  );
  const init = await run(['init', '--models', 'fable', '--force'], linked.env);
  assert.equal(init.code, 1);
  assert.match(init.stderr, /leads into jev-router's own files \(.*\)\. Remove it first: rm /);
  assert.equal(readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'), packagedText, 'the package is untouched');
  assert.ok(lstatSync(linked.configFile).isSymbolicLink());

  const box = await setupBox();
  const first = await setup(box, ['--yes', '--service', 'none'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(first.code, 0, first.stderr);
  const switched = await setup(box, ['--yes', '--service', 'none', '--models', 'fable']);
  assert.equal(switched.code, 0, switched.stderr);
  assert.match(switched.stderr, new RegExp(`^Switched ${box.configFile} from Claude only to Claude with Fable 5\\.1\\.$`, 'm'));
  assert.match(switched.stderr, /^A router that's already running keeps using Claude only until it restarts\.$/m);

  const edited = readFileSync(box.configFile, 'utf8').replace('"idleResetMinutes": 10', '"idleResetMinutes": 20');
  duringKeyCheck = () => writeFileSync(box.configFile, edited);
  const raced = await setup(box, ['--yes', '--service', 'none', '--models', 'claude']);
  assert.equal(raced.code, 0, raced.stderr);
  assert.match(raced.stderr, new RegExp(`^Kept ${box.configFile}: it changed while setup ran\\.$`, 'm'));
  assert.doesNotMatch(raced.stderr, /keeps using/, 'nothing switched');
  assert.equal(readFileSync(box.configFile, 'utf8'), edited, 'the edit wins');
});

test('a Jev key that fails its check writes nothing: setup offers another try, and --yes exits 1', async () => {
  const box = await setupBox();
  const declined = await setup(box, ['--service', 'none'], { input: `1\n${BAD}\nn\n` });
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, /it didn't work: typesafe: HTTP 401 invalid key\nTry another key\? \[Y\/n\] n\n/);
  assert.match(declined.stderr, /Nothing was written\./);
  assert.ok(!existsSync(join(box.config, 'jev-router')), 'no config, no env file');

  const retried = await setup(box, ['--service', 'none'], { input: `1\n${BAD}\ny\n\n${GOOD}\n` });
  assert.equal(retried.code, 0, retried.stderr);
  assert.match(retried.stderr, /OpenRouter API key \(press Enter to use a TypeSafe key instead\): \nChecking the OpenRouter key/);
  assert.match(readFileSync(box.envFile, 'utf8'), new RegExp(`^OPENROUTER_API_KEY=${GOOD}$`, 'm'), 'the key that worked');
  assert.doesNotMatch(readFileSync(box.envFile, 'utf8'), /TYPESAFE_API_KEY/, "and not the one that didn't");

  const other = await setupBox();
  const failed = await setup(other, ['--yes'], { env: { TYPESAFE_API_KEY: BAD } });
  assert.equal(failed.code, 1);
  assert.match(
    failed.stderr,
    /it didn't work: typesafe: HTTP 401 invalid key\nNothing was written\. Check the key, then run setup again\.\n$/,
  );
  assert.ok(!existsSync(join(other.config, 'jev-router')));
  for (const result of [declined, retried, failed]) assert.ok(!result.stderr.includes(BAD) && !result.stderr.includes(GOOD));

  const ended = await setup(other, [], { input: '1\n' });
  assert.equal(ended.code, 1);
  assert.match(ended.stderr, /Setup needs answers, but the input ended\. Nothing was written\./);
});

test("when Jev doesn't answer, setup says to check the connection rather than the key", async () => {
  const box = await setupBox();
  mkdirSync(join(box.config, 'jev-router'));
  const claudeOnly = JSON.parse(readFileSync(ANTHROPIC_ONLY_CONFIG, 'utf8'));
  const closed = await freePort();
  claudeOnly.jev.channels = [
    { name: 'mock', baseUrl: `http://127.0.0.1:${closed}`, model: 'jev-1.13.0', keyEnv: 'MOCK_JEV_KEY', timeoutMs: 1000 },
  ];
  writeFileSync(box.configFile, JSON.stringify(claudeOnly));
  const noAnswer =
    /Jev didn't answer, so the key wasn't checked\. Check the connection \(behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1\)/;

  const failed = await setup(box, ['--yes'], { env: { MOCK_JEV_KEY: GOOD } });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /it didn't work: mock: ECONNREFUSED\nNothing was written\. Jev didn't answer/);
  assert.match(failed.stderr, noAnswer);
  assert.doesNotMatch(failed.stderr, /Check the key/);
  assert.ok(!existsSync(box.envFile), 'no env file');

  const declined = await setup(box, ['--service', 'none'], { input: `${GOOD}\nn\n` });
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, new RegExp(`${noAnswer.source}\\.\\nTry again\\? \\[Y/n\\] n\\n`));
  assert.ok(!existsSync(box.envFile), 'still no env file');
  for (const result of [failed, declined]) assert.ok(!result.stderr.includes(GOOD));
});

test('Ctrl-C during a question stops setup with exit code 130, and nothing is written', async () => {
  const box = await setupBox();
  const running = start(['setup'], box.env, { input: null, node: ['--import', REDIRECT] });
  await waitFor(() => running.out.stderr.includes('Choose 1, 2 or 3 [1]: '), 'the first question');
  running.child.kill('SIGINT');
  const result = await running.done;
  assert.equal(result.code, 130);
  assert.match(result.stderr, /\nStopped\. Nothing was written\.\n$/);
  assert.ok(!existsSync(join(box.config, 'jev-router')));
});

test('without a service manager, setup saves the keys and says to start sessions with launch', async () => {
  const bare = await setupBox({ tools: [] });
  const result = await setup(bare, ['--yes'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\nDone\. There's no background service: /);
  assert.match(result.stderr, /Start Claude Code through the router with: jev-router launch claude\n/);
  assert.match(result.stderr, /Watch it live at http:\/\/127\.0\.0\.1:4100 with: jev-router launch claude --ui 4100\n/);
  assert.ok(result.stderr.endsWith(`Codex: put OLLAMA_API_KEY and OPENAI_API_KEY in ${bare.envFile}, then run: jev-router launch codex\n`));
  assert.doesNotMatch(result.stderr, /\n\n\n/);
  assert.ok(existsSync(bare.envFile) && !existsSync(bare.settings), "the keys are saved, and Claude Code's settings aren't touched");
  assert.deepEqual(bare.calls(), []);

  const doctor = await run(['doctor'], bare.env);
  assert.match(doctor.stdout, /^ {2}info service {3}none installed; jev-router setup installs one$/m);
  assert.match(doctor.stdout, /Ready\. Start a session with: jev-router launch claude\n$/);

  const container = await setupBox();
  const down = { TYPESAFE_API_KEY: GOOD, FAKE_SYSTEMD: 'down' };
  if (process.platform === 'linux') {
    const auto = await setup(container, ['--yes'], { env: down });
    assert.equal(auto.code, 0, auto.stderr);
    assert.match(auto.stderr, /There's no background service: there's no systemd user session here \(systemctl --user doesn't answer\)\./);
  }
  const explicit = await setup(container, ['--yes', '--service', 'systemd'], { env: down });
  assert.equal(explicit.code, 1);
  assert.match(explicit.stderr, /^jev-router: --service systemd: there's no systemd user session here/m);

  const declined = await setup(container, ['--service', 'systemd'], { input: `\n${GOOD}\nn\n` });
  assert.equal(declined.code, 0, declined.stderr);
  assert.match(declined.stderr, /There's no background service: you chose to start it yourself\./);
  assert.ok(!existsSync(container.unit));

  const bad = await run(['setup', '--service', 'cron'], container.env);
  assert.match(bad.stderr, /--service takes auto, launchd, systemd or none, got "cron"/);
  assert.match((await run(['setup', '--models', 'gpt'], container.env)).stderr, /--models takes claude, fable or ollama, got "gpt"/);
  assert.match((await run(['uninstall', 'now'], container.env)).stderr, /Usage: jev-router uninstall/);
});

test('setup stops before the service when something else holds the router port, and after writing the keys', async () => {
  const box = await setupBox();
  const { port } = await runningRouter();
  const env = { TYPESAFE_API_KEY: GOOD, JEV_ROUTER_PORT: String(port) };
  const result = await setup(box, ['--yes', '--service', 'systemd'], { env });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `A jev-router ${VERSION.replaceAll('.', '\\.')} already answers at http://127\\.0\\.0\\.1:${port}, probably one you started yourself`,
    ),
  );
  assert.match(result.stderr, /Stop it, then run setup again/);
  assert.ok(existsSync(box.envFile), 'the keys are saved');
  assert.ok(!existsSync(box.unit) && !existsSync(box.settings));
  assert.deepEqual(
    box.calls().map((call) => call.args[1]),
    ['show-environment'],
  );

  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', () => resolve(undefined)));
  const held = /** @type {import('node:net').AddressInfo} */ (holder.address()).port;
  const other = await setup(box, ['--yes', '--service', 'systemd'], { env: { ...env, JEV_ROUTER_PORT: String(held) } });
  holder.close();
  assert.equal(other.code, 1);
  assert.match(other.stderr, new RegExp(`Something else holds http://127\\.0\\.0\\.1:${held} \\(EADDRINUSE\\)`));
});

test("when the service's router doesn't answer, setup says where to look and leaves Claude Code alone", async () => {
  const box = await setupBox();
  const env = { TYPESAFE_API_KEY: GOOD, FAKE_SERVICE_START: '0', JEV_ROUTER_SETUP_WAIT: '1' };
  const systemd = await setup(box, ['--yes', '--service', 'systemd'], { env });
  assert.equal(systemd.code, 1);
  assert.match(
    systemd.stderr,
    /it didn't answer within 1 s\.\nSee what went wrong in: journalctl --user -u jev-router\nClaude Code's settings are unchanged\.\n$/,
  );
  assert.ok(existsSync(box.unit) && !existsSync(box.settings) && !existsSync(box.manifest));
  const doctor = await run(['doctor'], box.env);
  assert.match(
    doctor.stdout,
    new RegExp(
      `^ {2}warn service {3}systemd user unit ${box.unit}, but nothing answers at ${box.url}\\. See journalctl --user -u jev-router$`,
      'm',
    ),
  );

  const mac = await setupBox();
  const launchd = await setup(mac, ['--yes', '--service', 'launchd'], { env });
  assert.equal(launchd.code, 1);
  assert.match(launchd.stderr, new RegExp(`See what went wrong in: ${mac.home}/Library/Logs/jev-router/router\\.err\\.log\\n`));
});

test("a base URL for another gateway stays unless the person says yes, and settings that aren't JSON are left alone", async () => {
  const box = await setupBox();
  mkdirSync(join(box.home, '.claude'));
  const gateway = { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com', OTHER: 'x' } };
  writeFileSync(box.settings, JSON.stringify(gateway));
  const kept = await setup(box, ['--yes', '--service', 'systemd'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(kept.stderr, /send it to https:\/\/gateway\.example\.com\.\n--yes keeps that\./);
  assert.match(kept.stderr, /Claude Code's settings are unchanged: it keeps sending its requests to https:\/\/gateway\.example\.com\./);
  assert.match(kept.stderr, /Start Claude Code through the router with: jev-router launch claude\n/);
  assert.deepEqual(readJson(box.settings), gateway);

  const replaced = await setup(box, ['--service', 'systemd'], { input: '\n\n\ny\n' });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(replaced.stderr, /Replace that with the router\? \[y\/N\] y\n/);
  assert.equal(readJson(box.settings).env.ANTHROPIC_BASE_URL, box.url);
  assert.deepEqual(readJson(box.manifest).claude.env.ANTHROPIC_BASE_URL, { value: box.url, previous: 'https://gateway.example.com' });

  const broken = '{ "env": { "ANTHROPIC_BASE_URL": ';
  writeFileSync(box.settings, broken);
  const invalid = await setup(box, ['--yes', '--service', 'systemd'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(invalid.code, 0, invalid.stderr);
  assert.match(
    invalid.stderr,
    /Setup didn't change .*settings\.json: it isn't valid JSON\. Add this to its "env" block yourself:\n\{\n {2}"ANTHROPIC_BASE_URL": /,
  );
  assert.equal(readFileSync(box.settings, 'utf8'), broken, 'the file is left alone');
});

test('uninstall stops the service and takes back what setup changed, restoring what it replaced; a second run finds nothing', async () => {
  const box = await setupBox();
  mkdirSync(join(box.home, '.claude'));
  writeFileSync(box.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com', OTHER: 'x' } }));
  const installed = await setup(box, ['--service', 'systemd'], { input: `\n${GOOD}\n\ny\n` });
  assert.equal(installed.code, 0, installed.stderr);
  const settings = readJson(box.settings);
  settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '90000'; // changed by hand after setup
  writeFileSync(box.settings, JSON.stringify(settings));

  const removed = await run(['uninstall'], box.env);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(readJson(box.settings), {
    env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com', OTHER: 'x', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000' },
  });
  assert.match(removed.stderr, /removed CLAUDE_CODE_GATEWAY_HINT_HEADERS and ENABLE_TOOL_SEARCH; restored ANTHROPIC_BASE_URL\./);
  assert.match(removed.stderr, new RegExp(`Stopped and removed the systemd user unit ${box.unit}\\.`));
  assert.deepEqual(
    box
      .calls()
      .slice(-2)
      .map((call) => call.args.join(' ')),
    ['--user disable --now jev-router', '--user daemon-reload'],
  );
  assert.ok(!existsSync(box.unit) && !existsSync(box.manifest));
  assert.equal(await isListening(box.port), false, 'the router is stopped');
  assert.match(
    removed.stderr,
    new RegExp(`Kept your config, keys and logs:\\n {2}${box.config}/jev-router\\n {2}${box.state}/jev-router\\n`),
  );
  assert.match(removed.stderr, /To delete them too: rm -rf \S+config\/jev-router \S+state\/jev-router\n/);
  assert.match(removed.stderr, /Last step, to remove the jev-router command: npm uninstall -g @ediri\/jev-router\n$/);
  assert.ok(existsSync(box.envFile), 'the keys stay');

  const again = await run(['uninstall'], box.env);
  assert.equal(again.code, 0, again.stderr);
  assert.match(
    again.stderr,
    /^Nothing from setup in Claude Code's settings \(.*settings\.json\)\.\nNo background service is installed\.\n/,
  );

  const fresh = await setupBox();
  const created = await setup(fresh, ['--yes', '--service', 'launchd'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(created.code, 0, created.stderr);
  const gone = await run(['uninstall'], fresh.env);
  assert.match(gone.stderr, /Removed .*settings\.json, which setup had created\./);
  assert.ok(!existsSync(fresh.settings) && !existsSync(fresh.plist));
  assert.equal(fresh.calls().at(-1)?.args[0], 'bootout');
});

test('without a manifest, uninstall removes only a base URL that points at the router and the gateway settings with exactly its values', async () => {
  const box = await setupBox();
  mkdirSync(join(box.home, '.claude'));
  const port = String(box.port);
  const ours = {
    ANTHROPIC_BASE_URL: `http://localhost:${port}`,
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000',
    ENABLE_TOOL_SEARCH: 'true',
    ANTHROPIC_CUSTOM_HEADERS: `x-team: blue\nx-jev-router-token: ${ROUTER_TOKEN}`,
    KEEP: 'me',
  };
  writeFileSync(box.settings, JSON.stringify({ env: ours }));
  const removed = await run(['uninstall'], box.env);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(readJson(box.settings), {
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000', ANTHROPIC_CUSTOM_HEADERS: 'x-team: blue', KEEP: 'me' },
  });
  assert.ok(!removed.stderr.includes(ROUTER_TOKEN));

  const elsewhere = { ANTHROPIC_BASE_URL: 'https://gateway.example.com', ENABLE_TOOL_SEARCH: 'true' };
  writeFileSync(box.settings, JSON.stringify({ env: elsewhere }));
  assert.equal((await run(['uninstall'], box.env)).code, 0);
  assert.deepEqual(readJson(box.settings), { env: elsewhere }, 'another gateway keeps its settings');
  writeFileSync(box.settings, JSON.stringify({ env: ours }));
  const guessed = await run(['uninstall'], {
    ...box.env,
    JEV_ROUTER_ENV_FILE: join(box.root, 'gone.env'),
    JEV_ROUTER_CONFIG: join(box.root, 'gone.json'),
  });
  assert.equal(guessed.code, 0, 'an env file or config it cannot read changes nothing');
  assert.equal(readJson(box.settings).env.KEEP, 'me');
  writeFileSync(box.settings, '[1, 2]');
  const odd = await run(['uninstall'], box.env);
  assert.equal(odd.code, 1);
  assert.match(odd.stderr, /Couldn't change .*settings\.json: it isn't a JSON object\./);
});

/**
 * A copy of the package in a fake npx cache, run the way `npx <spec> setup` runs it: npx's bin
 * directory first on PATH, the spec npx recorded next to it, and a fake npm whose global prefix is
 * on PATH too.
 * @param {Awaited<ReturnType<typeof setupBox>>} box
 * @param {string} spec
 */
function npxCopy(box, spec) {
  const npx = join(box.root, 'npm-cache', '_npx', '5e7a9d1c');
  const pkg = join(npx, 'node_modules', '@ediri', 'jev-router');
  for (const dir of ['bin', 'src', 'config', 'examples', 'ui']) cpSync(join(ROOT, dir), join(pkg, dir), { recursive: true });
  writeFileSync(join(npx, 'package.json'), JSON.stringify({ dependencies: { '@ediri/jev-router': spec } }));
  mkdirSync(join(npx, 'node_modules', '.bin'));
  symlinkSync(join(pkg, 'bin', 'jev-router.mjs'), join(npx, 'node_modules', '.bin', 'jev-router'));
  const prefix = join(box.root, 'global');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const env = {
    PATH: [join(npx, 'node_modules', '.bin'), box.bin, join(prefix, 'bin')].join(':'),
    npm_command: 'exec',
    npm_lifecycle_event: 'npx',
    FAKE_NPM_LOG: join(box.root, 'npm.log'),
    FAKE_NPM_PREFIX: prefix,
    FAKE_NPM_LINK: BIN,
  };
  /** @returns {string[][]} the arguments of every npm call */
  const npm = () =>
    existsSync(env.FAKE_NPM_LOG)
      ? readFileSync(env.FAKE_NPM_LOG, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return { bin: join(pkg, 'bin', 'jev-router.mjs'), env, npm, prefix };
}

test('run through npx, setup installs jev-router with npm before it installs the service, and suggests commands that work', async () => {
  const box = await setupBox({ tools: ['systemctl', 'npm'], installed: false });
  const copy = npxCopy(box, '^1.5.0');
  const declined = await setup(box, ['--service', 'systemd'], { input: `\n${GOOD}\n\nn\n`, env: copy.env, bin: copy.bin });
  assert.equal(declined.code, 0, declined.stderr);
  assert.match(
    declined.stderr,
    new RegExp(
      `The background service needs a copy of jev-router that stays put, and npm can delete its npx cache at any time\\.\\nInstall it now with: npm install -g @ediri/jev-router@${VERSION.replaceAll('.', '\\.')}\\? \\[Y/n\\] n\\n`,
    ),
  );
  assert.match(declined.stderr, /Start Claude Code through the router with: npx @ediri\/jev-router launch claude\n/);
  assert.match(declined.stderr, /Check it: npx @ediri\/jev-router doctor\n/);
  assert.deepEqual(copy.npm(), [], 'no global install without a yes');
  assert.ok(!existsSync(box.unit));

  const accepted = await setup(box, ['--yes', '--service', 'systemd'], { env: copy.env, bin: copy.bin });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(copy.npm(), [['install', '-g', `@ediri/jev-router@${VERSION}`]]);
  assert.match(
    readFileSync(box.unit, 'utf8'),
    new RegExp(`^Environment="PATH=${copy.prefix}/bin:`, 'm'),
    "the service runs the global copy, never npx's",
  );
  assert.equal((await healthz(box.url)).ok, true);
  assert.match(accepted.stderr, /Check it: jev-router doctor\nUndo it: jev-router uninstall\n/, 'installed, the plain command works');
  const again = await setup(box, ['--yes', '--service', 'systemd'], { env: copy.env, bin: copy.bin });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(copy.npm().length, 1, 'the global copy has this version, so npx runs it without installing again');
});

test('npx specs: a git spec is installed as npx recorded it, and a file spec as an absolute path', async () => {
  for (const [spec, installs, hint] of [
    ['github:dirien/jev-router#semver:^1', 'github:dirien/jev-router#semver:^1', "npx 'github:dirien/jev-router#semver:^1'"],
    ['file:../../../ediri-jev-router-1.5.0.tgz', null, null],
  ]) {
    const box = await setupBox({ tools: ['systemctl', 'npm'], installed: false });
    const copy = npxCopy(box, /** @type {string} */ (spec));
    const tarball = join(box.root, 'ediri-jev-router-1.5.0.tgz');
    const result = await setup(box, ['--yes', '--service', 'none'], { env: { ...copy.env, TYPESAFE_API_KEY: GOOD }, bin: copy.bin });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      result.stderr.includes(`Start Claude Code through the router with: ${hint ?? `npx ${tarball}`} launch claude\n`),
      result.stderr,
    );
    const installing = await setup(box, ['--yes', '--service', 'systemd'], { env: copy.env, bin: copy.bin });
    assert.equal(installing.code, 0, installing.stderr);
    assert.deepEqual(copy.npm(), [['install', '-g', installs ?? tarball]]);
  }
});

test('run through npx, a failed npm install -g says to run the same npx command again', async () => {
  const box = await setupBox({ tools: ['systemctl', 'npm'], installed: false });
  const copy = npxCopy(box, 'latest');
  const env = { ...copy.env, TYPESAFE_API_KEY: GOOD, FAKE_NPM_FAIL: 'EACCES' };
  const failed = await setup(box, ['--yes', '--service', 'systemd'], { env, bin: copy.bin });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /The install failed: npm exited with 1\./);
  assert.match(failed.stderr, /run setup again \(npx @ediri\/jev-router setup\) and it picks up from here\.\n$/);
  assert.ok(existsSync(box.envFile) && !existsSync(box.unit) && !existsSync(box.settings));
});

test('with jev-router nowhere on PATH, a service needs a global install; declined, setup suggests this copy', async () => {
  const box = await setupBox({ tools: ['systemctl'], installed: false });
  const result = await setup(box, ['--service', 'systemd'], { input: `\n${GOOD}\n\nn\n` });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /The background service needs jev-router installed, and there's none on your PATH\.\n/);
  assert.match(result.stderr, /you chose not to install one \(npm install -g @ediri\/jev-router@/);
  assert.ok(result.stderr.includes(`Start Claude Code through the router with: ${BIN} launch claude\n`));
});

test('with jev-router nowhere on PATH, setup installs it with npm; a copy outside PATH is found through npm prefix -g', async () => {
  const box = await setupBox({ tools: ['systemctl', 'npm'], installed: false });
  const prefix = join(box.root, 'global');
  const npm = { FAKE_NPM_LOG: join(box.root, 'npm.log'), FAKE_NPM_PREFIX: prefix, FAKE_NPM_LINK: BIN, TYPESAFE_API_KEY: GOOD };
  const result = await setup(box, ['--yes', '--service', 'systemd'], { env: npm });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /The background service needs jev-router installed, and there's none on your PATH\.\n/);
  assert.match(
    result.stderr,
    new RegExp(`Installing jev-router for good: npm install -g @ediri/jev-router@${VERSION.replaceAll('.', '\\.')}\\n`),
  );
  assert.ok(result.stderr.includes(`note: npm put jev-router in ${prefix}/bin, which isn't on your PATH.`));
  assert.ok(result.stderr.includes(`Check it: ${prefix}/bin/jev-router doctor\n`), 'the hints name the command by its path');
  assert.deepEqual(readFileSync(npm.FAKE_NPM_LOG, 'utf8').trim().split('\n'), [
    JSON.stringify(['install', '-g', `@ediri/jev-router@${VERSION}`]),
    JSON.stringify(['prefix', '-g']),
  ]);
  assert.match(readFileSync(box.unit, 'utf8'), new RegExp(`^Environment="PATH=${prefix}/bin:`, 'm'));
  assert.equal((await healthz(box.url)).ok, true);
});

test('when npm install -g fails, setup installs no service, keeps the keys, and names the old package that holds the command', async () => {
  const box = await setupBox({ tools: ['systemctl', 'npm'], installed: false });
  const prefix = join(box.root, 'global');
  const env = {
    PATH: `${box.bin}:${join(prefix, 'bin')}`,
    FAKE_NPM_LOG: join(box.root, 'npm.log'),
    FAKE_NPM_PREFIX: prefix,
    FAKE_NPM_LINK: BIN,
    FAKE_NPM_FAIL: 'EACCES',
    TYPESAFE_API_KEY: GOOD,
  };
  const failed = await setup(box, ['--yes', '--service', 'systemd'], { env });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /npm error code EACCES\n/, "npm's own output shows");
  assert.match(
    failed.stderr,
    /The install failed: npm exited with 1\. The service isn't installed, and Claude Code's settings are unchanged\.\n/,
  );
  assert.match(
    failed.stderr,
    new RegExp(
      `Node from a version manager \\(nvm, fnm, or Homebrew on a Mac\\).*npm config set prefix ~/\\.local.*sudo npm install -g @ediri/jev-router@${VERSION.replaceAll('.', '\\.')}\\n`,
    ),
  );
  assert.ok(failed.stderr.includes(`run setup again (${BIN} setup) and it picks up from here.\n`));
  assert.ok(existsSync(box.envFile), 'the keys stay');
  assert.ok(!existsSync(box.unit) && !existsSync(box.settings));

  // jev-router 1.4.0 was @dirien/jev-router, and owns the command npm would link.
  const legacy = join(prefix, 'lib', 'node_modules', '@dirien', 'jev-router', 'bin');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'jev-router.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const owned = await setup(box, ['--yes', '--service', 'systemd'], { env: { ...env, FAKE_NPM_FAIL: 'EEXIST' } });
  assert.equal(owned.code, 1);
  assert.match(
    owned.stderr,
    /were called @dirien\/jev-router, and npm won't replace their command\. Remove it first:\n {2}npm uninstall -g @dirien\/jev-router\n/,
  );
});

test('setup asks again after an answer it cannot use, and a service manager that fails leaves Claude Code alone', async () => {
  const box = await setupBox();
  const asked = await setup(box, ['--service', 'systemd'], { input: `4\n3\n${GOOD}\n\n${OLLAMA}\n\n`, env: { FAKE_SYSTEMD: 'refuses' } });
  assert.equal(asked.code, 1);
  assert.match(asked.stderr, /Choose 1, 2 or 3 \[1\]: 4\nPlease answer 1, 2 or 3\.\nChoose 1, 2 or 3 \[1\]: 3\n/);
  assert.match(
    asked.stderr,
    /Ollama API key \(ollama\.com\) for Claude Code's fast tier: \nThat tier needs OLLAMA_API_KEY\.\nOllama API key/,
  );
  assert.match(
    asked.stderr,
    /jev-router: systemctl --user enable jev-router failed: Failed to enable unit: Access denied\nClaude Code's settings are unchanged\.\n$/,
  );
  assert.match(readFileSync(box.envFile, 'utf8'), new RegExp(`^OLLAMA_API_KEY=${OLLAMA}$`, 'm'));
  assert.ok(!existsSync(box.settings));

  const open = await setup(box, ['--yes', '--service', 'systemd'], { env: { JEV_ROUTER_HOST: '0.0.0.0' } });
  assert.equal(open.code, 1);
  assert.match(open.stderr, /the router won't listen on 0\.0\.0\.0 without a token\. Put JEV_ROUTER_TOKEN=<a secret> in /);

  const mac = await setupBox();
  mkdirSync(join(mac.config, 'jev-router'));
  writeFileSync(
    mac.envFile,
    `TYPESAFE_API_KEY=${GOOD}\nOLLAMA_API_KEY=${OLLAMA}\nOPENAI_API_KEY=${fake('sk-', 'openai-', 'DO-NOT-PRINT')}\n`,
  );
  const first = await setup(mac, ['--yes', '--service', 'launchd', '--models', 'ollama'], { env: { JEV_ROUTER_TOKEN: 'shell-only' } });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stderr, /note: JEV_ROUTER_TOKEN is set in this shell, but the service can't see it\./);
  assert.match(first.stderr, /Codex: jev-router launch codex\n$/, 'with every key Codex needs, the hint is just the command');

  // A re-run while the old router drains: launchd refuses to load the agent again until it has unloaded.
  const before = mac.calls().length;
  const started = Date.now();
  const slow = await setup(mac, ['--yes', '--service', 'launchd'], { env: { FAKE_LAUNCHD: 'slow' } });
  assert.equal(slow.code, 0, slow.stderr);
  const tries = mac
    .calls()
    .slice(before)
    .filter((call) => call.args[0] === 'bootstrap');
  assert.ok(tries.length >= 2, `launchd got ${tries.length} tries`);
  assert.ok(Date.now() - started >= 2000, 'setup waited for the old agent to unload');
  assert.equal((await healthz(mac.url)).ok, true);
});

const GATEWAY_TOKEN = fake('gw-', 'token-', 'DO-NOT-PRINT');

test("setup never points Claude Code at the router while it carries another gateway's credentials, and launch and env refuse", async () => {
  const box = await setupBox();
  const gateway = { ANTHROPIC_BASE_URL: 'https://litellm.example.com', ANTHROPIC_AUTH_TOKEN: GATEWAY_TOKEN };
  const guarded = await setup(box, ['--yes', '--service', 'systemd'], { env: { ...gateway, TYPESAFE_API_KEY: GOOD } });
  assert.equal(guarded.code, 0, guarded.stderr);
  assert.ok(
    guarded.stderr.includes(
      'Claude Code sends its requests to https://litellm.example.com (ANTHROPIC_BASE_URL in this shell), with ANTHROPIC_AUTH_TOKEN in this shell. ' +
        "Behind the router it would send those credentials to Anthropic, so setup doesn't point Claude Code at the router: " +
        'remove ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from your shell (its startup files, such as ~/.zshrc), open a new shell, then run setup again.\n',
    ),
    guarded.stderr,
  );
  assert.match(guarded.stderr, /Claude Code doesn't go through the router until you remove what's named above\.\n/);
  assert.doesNotMatch(guarded.stderr, /launch claude|Replace that/, 'launch would carry them too, and there is no question');
  assert.ok(!existsSync(box.settings), "Claude Code's settings stay as they are");
  assert.ok(!guarded.stderr.includes(GATEWAY_TOKEN), 'names only, never a value');
  assert.equal((await healthz(box.url)).ok, true, 'the service runs anyway');

  const asked = await setup(box, ['--service', 'systemd'], { input: '\n\n\n', env: gateway });
  assert.equal(asked.code, 0, asked.stderr);
  assert.doesNotMatch(asked.stderr, /Replace that/, 'no question either');
  assert.ok(!existsSync(box.settings));

  const launched = await run(['launch', 'claude'], { ...box.env, ...gateway, JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT });
  assert.equal(launched.code, 1);
  assert.ok(
    launched.stderr.endsWith(
      'Through the router, Claude Code would send those credentials to Anthropic. To leave them out, run: ' +
        'env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN jev-router launch claude\n',
    ),
    launched.stderr,
  );
  assert.ok(!existsSync(box.report), 'Claude Code never started');
  const exported = await run(['env', 'claude'], { ...box.env, ...gateway });
  assert.deepEqual({ code: exported.code, stdout: exported.stdout }, { code: 1, stdout: '' });
  assert.match(exported.stderr, /run: unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN; eval "\$\(jev-router env claude\)"\n$/);
  for (const result of [asked, launched, exported]) assert.ok(!result.stderr.includes(GATEWAY_TOKEN));

  const anthropic = { ANTHROPIC_AUTH_TOKEN: GATEWAY_TOKEN };
  assert.equal(
    (await run(['env', 'claude'], { ...box.env, ...anthropic })).code,
    0,
    'without another gateway, they are Anthropic credentials',
  );
  const direct = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: GATEWAY_TOKEN };
  assert.equal((await run(['env', 'claude'], { ...box.env, ...direct })).code, 0, "Anthropic's own API isn't another gateway");

  mkdirSync(join(box.home, '.claude'));
  writeFileSync(
    box.settings,
    JSON.stringify({ apiKeyHelper: '/usr/local/bin/gateway-token', env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' } }),
  );
  const helper = await setup(box, ['--service', 'systemd'], { input: '\n\n\n' });
  assert.equal(helper.code, 0, helper.stderr);
  assert.match(helper.stderr, /with apiKeyHelper in .*settings\.json\. Behind the router/);
  assert.match(helper.stderr, /remove ANTHROPIC_BASE_URL and apiKeyHelper from .*settings\.json, then run setup again\./);
  assert.equal(readJson(box.settings).env.ANTHROPIC_BASE_URL, 'https://gw.example.com');
  const helped = await run(['launch', 'claude'], {
    ...box.env,
    ANTHROPIC_BASE_URL: 'https://gw.example.com',
    JEV_ROUTER_CLAUDE_BIN: FAKE_AGENT,
  });
  assert.equal(helped.code, 1);
  assert.match(
    helped.stderr,
    /To leave them out, remove apiKeyHelper in .*settings\.json, then run: env -u ANTHROPIC_BASE_URL jev-router launch claude\n$/,
  );
});

test('a gateway added to the shell after setup: doctor fails, and setup takes its own settings back out', async () => {
  const gateway = { ANTHROPIC_BASE_URL: 'https://litellm.example.com', ANTHROPIC_AUTH_TOKEN: GATEWAY_TOKEN };
  const failLine =
    'FAIL claude    Claude Code uses the router (ANTHROPIC_BASE_URL in {settings}), and this shell also sends it to ' +
    'https://litellm.example.com with ANTHROPIC_AUTH_TOKEN in this shell: through the router, those credentials go to Anthropic.';

  const box = await setupBox();
  const first = await setup(box, ['--yes', '--service', 'systemd'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(readJson(box.settings).env.ANTHROPIC_BASE_URL, box.url, 'setup pointed Claude Code at the router');
  const doctor = await run(['doctor'], { ...box.env, ...gateway });
  assert.equal(doctor.code, 1, doctor.stdout);
  assert.ok(doctor.stdout.includes(failLine.replace('{settings}', box.settings)), doctor.stdout);
  assert.match(doctor.stdout, /Not ready/);

  const second = await setup(box, ['--yes', '--service', 'systemd'], { env: { ...gateway, TYPESAFE_API_KEY: GOOD } });
  assert.equal(second.code, 0, second.stderr);
  assert.ok(
    second.stderr.includes(
      `Claude Code's settings (${box.settings}) sent it to the router, and so those credentials too: ` +
        'setup removed the file, which it had created.',
    ),
    second.stderr,
  );
  assert.ok(!existsSync(box.settings), 'Claude Code goes to the gateway again');
  assert.equal(readJson(box.manifest).claude, undefined, 'nothing is left for uninstall to take back');
  assert.doesNotMatch((await run(['doctor'], { ...box.env, ...gateway })).stdout, /FAIL claude/);

  const own = await setupBox();
  mkdirSync(join(own.home, '.claude'));
  writeFileSync(own.settings, JSON.stringify({ model: 'opus', env: { OTHER: 'x' } }));
  assert.equal((await setup(own, ['--yes', '--service', 'systemd'], { env: { TYPESAFE_API_KEY: GOOD } })).code, 0);
  const taken = await setup(own, ['--yes', '--service', 'systemd'], { env: { ...gateway, TYPESAFE_API_KEY: GOOD } });
  assert.equal(taken.code, 0, taken.stderr);
  assert.match(taken.stderr, /setup took ANTHROPIC_BASE_URL, .*ENABLE_TOOL_SEARCH back out\. The old file is .*\.jev-router\.bak\./);
  assert.deepEqual(readJson(own.settings), { model: 'opus', env: { OTHER: 'x' } }, 'the settings are as they were before setup');
  for (const result of [doctor, second, taken]) assert.ok(!result.stdout.includes(GATEWAY_TOKEN) && !result.stderr.includes(GATEWAY_TOKEN));
});
test('a base URL from this shell without credentials gets the question, which says the settings file would override it', async () => {
  const box = await setupBox();
  const proxy = { ANTHROPIC_BASE_URL: 'https://proxy.example.com' };
  const asked = await setup(box, ['--service', 'systemd'], { input: `\n${GOOD}\n\n\n`, env: proxy });
  assert.equal(asked.code, 0, asked.stderr);
  assert.ok(
    asked.stderr.includes(
      `This shell sends Claude Code to https://proxy.example.com (ANTHROPIC_BASE_URL). The router's address in ${box.settings} would override that in every session.\nReplace that with the router? [y/N] \n`,
    ),
    asked.stderr,
  );
  assert.ok(!existsSync(box.settings), 'Enter means no');
  assert.match(
    asked.stderr,
    /Start Claude Code through the router with: jev-router launch claude\n/,
    'without credentials, launch is fine',
  );
  const kept = await setup(box, ['--yes', '--service', 'systemd'], { env: proxy });
  assert.match(kept.stderr, /--yes keeps that\./);
  const replaced = await setup(box, ['--service', 'systemd'], { input: '\n\n\ny\n', env: proxy });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(readJson(box.settings).env.ANTHROPIC_BASE_URL, box.url, 'a yes replaces it');
});

test("after a port change, setup's own address is its own, and uninstall restores what was there before setup", async () => {
  const box = await setupBox();
  mkdirSync(join(box.home, '.claude'));
  writeFileSync(box.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }));
  const first = await setup(box, ['--service', 'systemd'], { input: `\n${GOOD}\n\ny\n` });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(readJson(box.settings).env.ANTHROPIC_BASE_URL, box.url);

  const port = await freePort();
  const moved = { ...box.env, JEV_ROUTER_PORT: String(port) };
  const second = await run(['setup', '--yes', '--service', 'systemd'], moved, { node: ['--import', REDIRECT] });
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /send it to|Replace that/, "the old router address is setup's own, not another gateway");
  const url = `http://127.0.0.1:${port}`;
  assert.equal(readJson(box.settings).env.ANTHROPIC_BASE_URL, url);
  assert.match(readFileSync(box.envFile, 'utf8'), new RegExp(`^JEV_ROUTER_PORT=${port}$`, 'm'), 'the new port is saved');
  assert.deepEqual(readJson(box.manifest).claude.env.ANTHROPIC_BASE_URL, { value: url, previous: 'https://gateway.example.com' });
  assert.equal((await healthz(url)).ok, true);

  const removed = await run(['uninstall'], box.env); // the env file has the port now
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(readJson(box.settings), { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }, 'the true original');
});

test('a settings file and an env file that are symbolic links stay links, and the files they point to change', async () => {
  const box = await setupBox();
  const dotfiles = join(box.root, 'dotfiles');
  mkdirSync(dotfiles);
  writeFileSync(join(dotfiles, 'settings.json'), JSON.stringify({ model: 'opus' }));
  chmodSync(join(dotfiles, 'settings.json'), 0o644);
  writeFileSync(join(dotfiles, 'env'), `TYPESAFE_API_KEY=${GOOD}\n`, { mode: 0o600 });
  mkdirSync(join(box.home, '.claude'));
  symlinkSync(join(dotfiles, 'settings.json'), box.settings);
  mkdirSync(join(box.config, 'jev-router'));
  symlinkSync(join(dotfiles, 'env'), box.envFile);
  const result = await setup(box, ['--yes', '--service', 'systemd']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(lstatSync(box.settings).isSymbolicLink() && lstatSync(box.envFile).isSymbolicLink(), 'both are still links');
  assert.equal(readJson(join(dotfiles, 'settings.json')).env.ANTHROPIC_BASE_URL, box.url);
  assert.match(readFileSync(join(dotfiles, 'env'), 'utf8'), new RegExp(`^JEV_ROUTER_PORT=${box.port}$`, 'm'));
  assert.equal(modeOf(join(dotfiles, 'settings.json')), 0o644, 'without a router token, the mode stays');
  const backup = `${box.settings}.jev-router.bak`;
  assert.ok(lstatSync(backup).isFile());
  assert.deepEqual(readJson(backup), { model: 'opus' });
  assert.equal(modeOf(backup), 0o600);
});

test('uninstall keeps its record of the settings when it cannot read them, and a later uninstall finishes', async () => {
  const box = await setupBox();
  const installed = await setup(box, ['--yes', '--service', 'systemd'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(installed.code, 0, installed.stderr);
  const settings = readFileSync(box.settings, 'utf8');
  writeFileSync(box.settings, '{ "env": ');
  const stuck = await run(['uninstall'], box.env);
  assert.equal(stuck.code, 1);
  assert.match(stuck.stderr, /Couldn't change .*settings\.json: it isn't valid JSON\. Fix it, then run jev-router uninstall again\.\n/);
  assert.match(stuck.stderr, /Kept .*setup\.json, so that jev-router uninstall can finish once the settings file is fixed\.\n/);
  assert.ok(!existsSync(box.unit), 'the service is gone');
  assert.equal(readJson(box.manifest).service, undefined);
  assert.equal(readJson(box.manifest).claude.env.ANTHROPIC_BASE_URL.value, box.url);
  writeFileSync(box.settings, settings);
  const finished = await run(['uninstall'], box.env);
  assert.equal(finished.code, 0, finished.stderr);
  assert.match(finished.stderr, /Removed .*settings\.json, which setup had created\./);
  assert.ok(!existsSync(box.manifest));
});

test("the systemd unit goes where the user manager looks, which needn't be the shell's XDG_CONFIG_HOME", async () => {
  const box = await setupBox();
  const manager = join(box.root, 'manager-config');
  const env = { TYPESAFE_API_KEY: GOOD, FAKE_SYSTEMD_XDG: manager };
  const result = await setup(box, ['--yes', '--service', 'systemd'], { env });
  assert.equal(result.code, 0, result.stderr);
  const unit = join(manager, 'systemd', 'user', 'jev-router.service');
  assert.ok(existsSync(unit) && !existsSync(box.unit) && !existsSync(join(box.config, 'systemd')));
  const doctor = await run(['doctor'], { ...box.env, FAKE_SYSTEMD_XDG: manager });
  assert.match(doctor.stdout, new RegExp(`^ {2}ok {3}service {3}systemd user unit ${unit};`, 'm'));
  rmSync(box.manifest); // found without setup's record too, by asking the user manager
  assert.match((await run(['doctor'], { ...box.env, FAKE_SYSTEMD_XDG: manager })).stdout, new RegExp(`systemd user unit ${unit};`));
  const removed = await run(['uninstall'], { ...box.env, FAKE_SYSTEMD_XDG: manager });
  assert.match(removed.stderr, new RegExp(`Stopped and removed the systemd user unit ${unit}\\.`));
  assert.ok(!existsSync(unit));
});

test('Ctrl-C after the key check under --yes still writes nothing', async () => {
  const box = await setupBox();
  // Something that holds the port and never answers keeps setup busy for a second after the key check.
  const holder = net.createServer(() => undefined);
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (holder.address()).port;
  const env = { ...box.env, TYPESAFE_API_KEY: GOOD, JEV_ROUTER_PORT: String(port) };
  const running = start(['setup', '--yes', '--service', 'systemd'], env, { node: ['--import', REDIRECT] });
  await waitFor(() => running.out.stderr.includes('it works'), 'the key check');
  running.child.kill('SIGINT');
  const result = await running.done;
  holder.close();
  assert.equal(result.code, 130, result.stderr);
  assert.match(result.stderr, /\nStopped\. Nothing was written\.\n$/);
  assert.ok(!existsSync(join(box.config, 'jev-router')));
});

test("uninstall guesses only without a manifest, and only from a base URL that points at the router; values that aren't strings stay", async () => {
  const box = await setupBox();
  mkdirSync(join(box.home, '.claude'));
  const own = { ENABLE_TOOL_SEARCH: true, CLAUDE_CODE_AUTO_COMPACT_WINDOW: 90000 };
  writeFileSync(box.settings, JSON.stringify({ env: own }));
  const installed = await setup(box, ['--yes', '--service', 'systemd'], { env: { TYPESAFE_API_KEY: GOOD } });
  assert.equal(installed.code, 0, installed.stderr);
  assert.deepEqual(readJson(box.settings).env, { ...own, ANTHROPIC_BASE_URL: box.url, CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1' });
  assert.equal((await run(['uninstall'], box.env)).code, 0);
  assert.deepEqual(readJson(box.settings), { env: own }, 'never overwritten, never removed');

  const noSettings = await setup(box, ['--yes', '--service', 'systemd', '--no-claude-settings']);
  assert.equal(noSettings.code, 0, noSettings.stderr);
  const byHand = { ANTHROPIC_BASE_URL: box.url, CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1' };
  writeFileSync(box.settings, JSON.stringify({ env: byHand }));
  const kept = await run(['uninstall'], box.env);
  assert.match(kept.stderr, /^Setup didn't change Claude Code's settings\.\n/);
  assert.deepEqual(readJson(box.settings), { env: byHand }, 'setup recorded no settings, so there is nothing to guess');

  const noBase = { CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1', ENABLE_TOOL_SEARCH: 'true' };
  writeFileSync(box.settings, JSON.stringify({ env: noBase }));
  await run(['uninstall'], box.env);
  assert.deepEqual(readJson(box.settings), { env: noBase }, 'no base URL that points at the router, no guess');
});

test('a key with a space is asked again, and settings that setup cannot write get a manifest first and the lines to add by hand', async () => {
  const box = await setupBox();
  const spaced = await setup(box, ['--service', 'none'], { input: `\nbad key\n${GOOD}\n` });
  assert.equal(spaced.code, 0, spaced.stderr);
  assert.match(spaced.stderr, /That key has a space or a control character in it, which no key has\. Paste it again\.\n/);
  const yes = await setup(box, ['--yes'], { env: { TYPESAFE_API_KEY: `tab\there` } });
  assert.equal(yes.code, 1);
  assert.match(yes.stderr, /TYPESAFE_API_KEY holds a space or a control character, which no key has\./);

  const locked = await setupBox();
  if (process.getuid?.() === 0) return; // root writes anywhere
  mkdirSync(join(locked.home, '.claude'));
  writeFileSync(locked.settings, '{}');
  chmodSync(join(locked.home, '.claude'), 0o500);
  try {
    const env = { TYPESAFE_API_KEY: GOOD, JEV_ROUTER_SETUP_WAIT: 'soon' };
    const result = await setup(locked, ['--yes', '--service', 'systemd'], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /note: JEV_ROUTER_SETUP_WAIT takes a number of seconds above 0, not "soon", so setup waits 15 s\.\n/);
    assert.match(
      result.stderr,
      /Setup didn't change .*settings\.json: setup can't write it \(permission denied\)\. Add this to its "env" block yourself:/,
    );
    assert.equal(readJson(locked.manifest).claude.env.ANTHROPIC_BASE_URL.value, locked.url, 'the manifest was written first');
  } finally {
    chmodSync(join(locked.home, '.claude'), 0o700);
  }
});

test('setup refuses a launchd without a GUI session, and a /dev/null env file', async () => {
  const box = await setupBox();
  const nogui = await setup(box, ['--yes', '--service', 'launchd'], { env: { TYPESAFE_API_KEY: GOOD, FAKE_LAUNCHD: 'nogui' } });
  assert.equal(nogui.code, 1);
  assert.match(
    nogui.stderr,
    /--service launchd: there's no GUI login session here \(for example over SSH\), so launchd can't run an agent/,
  );
  const off = await setup(box, ['--yes'], { env: { TYPESAFE_API_KEY: GOOD, JEV_ROUTER_ENV_FILE: '/dev/null' } });
  assert.equal(off.code, 1);
  assert.equal(
    off.stderr,
    'jev-router: JEV_ROUTER_ENV_FILE is /dev/null, which turns the env file off, so setup has nowhere to save the keys. Unset it, then run setup again.\n',
  );
  assert.ok(!existsSync(join(box.config, 'jev-router')));
});
