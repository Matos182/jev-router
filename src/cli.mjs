// The jev-router command. `setup` installs the router as a service and points Claude Code at it, and
// `uninstall` undoes that; `serve` runs the router in the foreground; `launch` runs Claude Code or
// Codex through a router for one session; `env`, `doctor`, `init`, `report` and `ui` set it up by
// hand and read its log. What scripts consume (exports, reports, the router log under `serve`) goes
// to stdout, messages for people go to stderr.
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, constants as osConstants } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CLAUDE_SETTINGS,
  claudeCredentials,
  claudeVars,
  credentialsInWords,
  foreignBaseUrl,
  pointsAtRouter,
  readSettings,
  settingsEnv,
} from './claude.mjs';
import { loadConfig } from './config.mjs';
import { agentEnv, loadEnvFile } from './envfile.mjs';
import {
  claudeSettingsPath,
  configFile,
  envValue,
  errorCode,
  errorMessage,
  findProgram,
  inPackage,
  MODEL_CHOICES,
  makeDirectory,
  namedLogFile,
  PACKAGED_CONFIGS,
  packaged,
  routerLogPath,
  shellQuote,
  userConfigPath,
} from './files.mjs';
import { isLoopbackBaseUrl, JevClient, SAMPLE_STATE } from './jev.mjs';
import { appendLogLine } from './logfile.mjs';
import { clientHost, isLoopback, LOOPBACK, parsePort, parseUiAddress, probe, TOKEN_HEADER, UI_PORT, urlHost } from './net.mjs';
import { createRouter, describeConfig, report, VERSION } from './router.mjs';
import { installedServices, logHint, MANAGER_NAMES } from './service.mjs';
import { inWords, readManifest, runSetup } from './setup.mjs';
import { createUiServer } from './ui.mjs';
import { runUninstall } from './uninstall.mjs';

/** @import { Config, Health, Models, RouterServer, UiServer } from './types.js' */
/** @import { EnvFile } from './envfile.mjs' */
/** @import { SetupOptions } from './setup.mjs' */
/** @import { Credential } from './claude.mjs' */

/**
 * @typedef {'ok' | 'warn' | 'FAIL' | 'hint' | 'info'} Status
 * @typedef {{ add: (status: Status, topic: string, text: string) => void, lines: string[], readonly failed: boolean }} Checklist
 */

const CODEX_TEMPLATE = packaged('examples/codex/jev.config.toml');
const CODEX_MODELS = packaged('examples/codex/jev-models.json');

const HELP = `jev-router ${VERSION}: picks a model tier for every Claude Code or Codex turn with Jev.

Usage:
  jev-router setup [--yes] [--models claude|fable|ollama] [--service auto|launchd|systemd|none]
                   [--no-claude-settings]
  jev-router uninstall
  jev-router [serve] [--config <file>] [--env-file <file>] [--log-file <file>] [--host <h>] [--port <n>]
                     [--ui [<host>:]<port>] [--ui-token <token>]
  jev-router launch claude [--config <file>] [--env-file <file>] [--port <n>] [--ui [<host>:]<port>]
                           [--] [claude args…]
  jev-router launch codex  [--config <file>] [--env-file <file>] [--port <n>] [--ui [<host>:]<port>]
                           [--force] [--] [codex args…]
  jev-router env claude|codex [--config <file>] [--env-file <file>] [--port <n>]
  jev-router doctor [--config <file>] [--env-file <file>] [--live]
  jev-router init [--models claude|fable|ollama] [--force]
  jev-router report [<log.jsonl>]
  jev-router ui [<log.jsonl>] [--port <n>] [--ui-token <token>]
  jev-router version | help

  setup      ask which models Claude Code uses and for their keys, check the Jev key with one call,
             then save them, run the router in the background and point Claude Code at it. Safe to
             run again, also to switch models. --yes takes the defaults and the keys from the environment
  uninstall  remove the service and what setup put in Claude Code's settings; keeps the config, keys and logs
  serve      run the router in the foreground (the default command); --ui also serves the live view
  launch     run Claude Code or Codex through the router on the configured port, starting one if none
             runs; --ui also serves the live view of a router it starts
  env        print shell exports for a running router: eval "$(jev-router env claude)"
  doctor     check the config, the keys, the service and a running router; --live makes one Jev call
             (~$0.00003)
  init       write the user config from a packaged one: Ollama Cloud and Claude, or the one --models
             names (--anthropic-only is --models claude)
  report     sum up requests, spend and savings from a router log
  ui         serve the live view for a router log another process writes (http://127.0.0.1:4100)

Config: --config, else $JEV_ROUTER_CONFIG, else $XDG_CONFIG_HOME/jev-router/config.json
(~/.config by default) if it exists, else the packaged default. JEV_ROUTER_HOST and
JEV_ROUTER_PORT override the config's host and port; the flags override both.
JEV_ROUTER_UI works like --ui for serve and launch. With --ui-token, else $JEV_ROUTER_UI_TOKEN, the live view asks
for that token: open the address serve or ui prints, which carries it.

Keys: a file of KEY=VALUE lines (mode 600) is loaded before anything reads the environment:
--env-file, else $JEV_ROUTER_ENV_FILE, else $XDG_CONFIG_HOME/jev-router/env if it exists
(~/.config by default), which is where setup saves them. Variables already set win. launch keeps
the file's variables away from the agent. Proxy settings (HTTPS_PROXY, NODE_USE_ENV_PROXY) don't
work from it: Node reads them at startup.

Service: setup runs \`jev-router serve --ui 4100\` as a launchd agent (macOS) or a systemd user
unit (Linux) with the config, env file and log it used, and waits up to $JEV_ROUTER_SETUP_WAIT
seconds (15) for it to answer. Without a service manager, or when you answer no, it stops after
saving the keys: start sessions with jev-router launch claude.

Log: serve writes JSON lines to stdout and to --log-file, else $JEV_ROUTER_LOG_FILE, else the
config's logFile (its directory is created for --log-file and $JEV_ROUTER_LOG_FILE). The file
rotates to <file>.1 at the config's logMaxBytes (50 MiB). report and ui read $JEV_ROUTER_LOG_FILE,
else the config's logFile, else the log launch writes.
`;

/**
 * Runs one jev-router command.
 * @param {string[]} argv the arguments after the program name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number | undefined>} the exit code, or undefined while `serve` keeps running
 */
export async function main(argv, env = process.env) {
  const [first] = argv;
  // `jev-router --port 4001` means `jev-router serve --port 4001`.
  const implicit = first === undefined || (first.startsWith('-') && !Object.hasOwn(COMMANDS, first));
  const name = implicit ? 'serve' : first;
  if (!Object.hasOwn(COMMANDS, name)) throw new Error(`unknown command "${name}". Run "jev-router help" for usage.`);
  return COMMANDS[name](implicit ? argv : argv.slice(1), env);
}

/**
 * Parses `--name value`, `--name=value` and boolean `--flag` options.
 * @param {string[]} args
 * @param {Record<string, 'value' | 'flag'>} spec the options the command takes
 * @param {{ passthrough?: boolean }} [mode] passthrough: stop at the first argument that isn't
 *   ours (or at `--`) and hand the rest to the agent untouched
 * @returns {{ values: Record<string, string | undefined>, flags: Set<string>, rest: string[] }}
 */
function parseArgs(args, spec, { passthrough = false } = {}) {
  /** @type {{ values: Record<string, string | undefined>, flags: Set<string>, rest: string[] }} */
  const parsed = { values: {}, flags: new Set(), rest: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const option = readOption(arg, spec);
    if (arg === '--' || (passthrough && !option)) {
      parsed.rest.push(...args.slice(arg === '--' ? i + 1 : i));
      break;
    }
    if (!option) {
      if (arg.startsWith('-')) throw new Error(`unknown option ${arg}. Run "jev-router help" for usage.`);
      parsed.rest.push(arg);
      continue;
    }
    if (option.kind === 'flag') {
      if (option.inline !== undefined) throw new Error(`${option.name} takes no value`);
      parsed.flags.add(option.key);
      continue;
    }
    const value = option.inline ?? args[i + 1];
    if (option.inline === undefined) i += 1;
    if (!value) throw new Error(`${option.name} needs a value`);
    parsed.values[option.key] = value;
  }
  return parsed;
}

/**
 * @param {string} arg
 * @param {Record<string, 'value' | 'flag'>} spec
 * @returns {{ name: string, key: string, kind: 'value' | 'flag', inline?: string } | undefined} the option `arg` names, if the command takes it
 */
function readOption(arg, spec) {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  const name = eq > 2 ? arg.slice(0, eq) : arg;
  if (!Object.hasOwn(spec, name)) return undefined;
  return { name, key: name.replace(/^--?/, ''), kind: spec[name], inline: eq > 2 ? arg.slice(eq + 1) : undefined };
}

/** @param {NodeJS.ProcessEnv} env */
const codexProfilePath = (env) => join(envValue(env, 'CODEX_HOME') ?? join(homedir(), '.codex'), 'jev.config.toml');

/**
 * Loads the env file for a command, and says on stderr what is wrong with it.
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {EnvFile | undefined}
 */
function useEnvFile(flag, env) {
  const file = loadEnvFile(flag, env);
  for (const warning of file?.warnings ?? []) console.error(`jev-router: ${warning}`);
  return file;
}

/**
 * Loads the config and works out where the router listens and which token it expects.
 * @param {Record<string, string | undefined>} values the parsed --config, --host and --port
 * @param {NodeJS.ProcessEnv} env
 */
function settings(values, env) {
  const { path, source } = configFile(values.config, env);
  const cfg = loadConfig(path);
  const host = values.host ?? envValue(env, 'JEV_ROUTER_HOST') ?? cfg.host;
  const port = parsePort(values.port ?? envValue(env, 'JEV_ROUTER_PORT') ?? cfg.port);
  // The router reads the token the same way, so an empty JEV_ROUTER_TOKEN turns it off in both.
  const token = env.JEV_ROUTER_TOKEN ?? cfg.token;
  return { cfg, path, source, host, port, token };
}

/**
 * Why a log line couldn't be written, in a few words.
 * @param {unknown} err
 */
function writeProblem(err) {
  const code = errorCode(err);
  if (code === 'ENOENT') return 'its directory does not exist';
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOSPC') return 'no space left on the device';
  if (code === 'EISDIR') return 'it is a directory';
  return errorMessage(err);
}

/**
 * The router's log: one JSON line per event, for `echo` and appended to each file (created with
 * mode 0600). A file rotates to `<file>.1` before it would grow past `maxBytes`. A file that can't
 * be written costs its own lines and never a request: its first failure becomes a warning entry
 * for the other outputs, and `tell` hears about it, and about the file working again.
 * @param {() => { files: Array<string | null | undefined>, maxBytes: number }} targets looked up for every line, so a
 *   reloaded config's logFile and logMaxBytes apply
 * @param {{ echo?: (entry: Record<string, unknown>, line: string) => void, tell?: (text: string) => void }} [outputs]
 * @returns {(entry: Record<string, unknown>) => void}
 */
function logger(targets, { echo, tell } = {}) {
  /** @type {Set<string>} files whose last write failed */
  const failing = new Set();
  /** @param {Record<string, unknown>} entry */
  const write = (entry) => {
    const line = `${JSON.stringify(entry)}\n`;
    echo?.(entry, line);
    const { files, maxBytes } = targets();
    /** @type {string[]} */
    const problems = [];
    for (const file of new Set(files)) {
      if (!file) continue;
      try {
        appendLogLine(file, line, maxBytes);
        if (failing.delete(file)) tell?.(`jev-router: the log file ${file} can be written again`);
      } catch (err) {
        if (failing.has(file)) continue;
        failing.add(file);
        problems.push(`cannot write the log file ${file}: ${writeProblem(err)}. Its lines are lost until it can be written.`);
      }
    }
    // A failing file is marked already, so these warnings can't fail into another round.
    for (const message of problems) {
      tell?.(`jev-router: ${message}`);
      write({ ts: new Date().toISOString(), event: 'warning', message });
    }
  };
  return write;
}

/**
 * Logs where the config routes, so `jev-router ui` can draw it. Called at start and after a reload.
 * @param {(entry: Record<string, unknown>) => void} log
 * @param {Config} cfg
 */
const logConfig = (log, cfg) => log({ ts: new Date().toISOString(), event: 'config', ...describeConfig(cfg) });

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<number>} the port the server got
 */
function listen(server, port, host) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      const address = server.address();
      done(typeof address === 'object' && address ? address.port : port);
    });
  });
}

/**
 * `jev-router [serve]`: runs the router in the foreground and logs one JSON line per event to stdout,
 * and to --log-file, JEV_ROUTER_LOG_FILE or the config's logFile. SIGHUP reloads the config; SIGTERM
 * and SIGINT let in-flight requests finish for up to 30 s, then exit, and a second one stops it at once.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<undefined>}
 */
async function serve(args, env) {
  const { values, rest } = parseArgs(args, {
    '--config': 'value',
    '--env-file': 'value',
    '--host': 'value',
    '--log-file': 'value',
    '--port': 'value',
    '--ui': 'value',
    '--ui-token': 'value',
  });
  if (rest.length) throw new Error(`serve takes no arguments, got "${rest.join(' ')}"`);
  useEnvFile(values['env-file'], env);
  const { cfg: loaded, path, host, port, token } = settings(values, env);
  // A service passes its log file on the command line, often in a directory that doesn't exist yet.
  const logFile = namedLogFile(values['log-file'], env);
  if (logFile) makeDirectory(dirname(logFile));
  if (!isLoopback(host) && !token) throw new Error(`Refusing to listen on ${host} without a token: set JEV_ROUTER_TOKEN.`);
  const uiAddress = parseUiAddress(values.ui ?? envValue(env, 'JEV_ROUTER_UI'));
  let cfg = { ...loaded, host, port };
  let stdoutBroken = false;
  // A closed pipe must not crash the router: `serve 2>&1 | tee router.log` loses both when tee goes.
  process.stdout.on('error', () => {
    stdoutBroken = true;
  });
  process.stderr.on('error', () => undefined);
  const uiToken = values['ui-token'] ?? envValue(env, 'JEV_ROUTER_UI_TOKEN');
  const view = uiAddress ? createUiServer({ token: uiToken }) : undefined;
  const log = logger(() => ({ files: [logFile ?? cfg.logFile], maxBytes: cfg.logMaxBytes }), {
    echo: (entry, line) => {
      if (!stdoutBroken) process.stdout.write(line);
      view?.publish(entry);
    },
    tell: (text) => console.error(text),
  });
  /** @param {string} text a message for people: stderr, and a notice in the live view */
  const say = (text) => {
    console.error(text);
    view?.publish({ ts: new Date().toISOString(), event: 'text', text });
  };
  const server = createRouter(cfg, { log });
  // The signal handlers come first: "listening on" is the line a supervisor or a test waits for,
  // and a SIGHUP that arrived before its handler would end the process.
  process.on('SIGHUP', () => {
    try {
      cfg = { ...loadConfig(path), host, port };
      server.reload(cfg);
      logConfig(log, cfg);
      say('jev-router: config reloaded');
    } catch (err) {
      say(`jev-router: reload failed, keeping the old config\n${errorMessage(err)}`);
    }
  });
  let stopping = false;
  /** @param {NodeJS.Signals} signal */
  const shutdown = (signal) => {
    // A second signal while requests drain means now: an impatient Ctrl-C shouldn't need a SIGKILL.
    if (stopping) {
      console.error(`jev-router: stopping now, cutting ${server.active} request(s)`);
      process.exit(128 + osConstants.signals[signal]);
    }
    stopping = true;
    console.error(`jev-router: shutting down, waiting for ${server.active} request(s)`);
    void view?.close();
    server.close();
    const deadline = Date.now() + 30000;
    const wait = setInterval(() => {
      if (server.active === 0 || Date.now() > deadline) {
        clearInterval(wait);
        if (server.active) console.error(`jev-router: 30 s passed, cutting ${server.active} request(s)`);
        process.exit(0);
      }
    }, 100);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const bound = await listen(server, port, host).catch((err) => {
    throw new Error(`cannot listen on ${urlHost(host)}:${port}: ${errorMessage(err)}`);
  });
  console.error(`jev-router ${VERSION} listening on http://${urlHost(host)}:${bound}`);
  logConfig(log, cfg);
  if (view && uiAddress) await startView(view, uiAddress, uiToken);
  return undefined;
}

/**
 * The address of the live view to open: with its token, when it has one.
 * @param {string} url
 * @param {string | undefined} token
 */
const viewUrl = (url, token) => (token === undefined ? url : `${url}?token=${encodeURIComponent(token)}`);

/**
 * Starts the live view of `serve --ui`. A view that can't listen is reported, and routing goes on
 * without it: the view must never take the router down.
 * @param {UiServer} view
 * @param {{ host: string, port: number }} address
 * @param {string | undefined} token what the view asks for, if anything
 */
async function startView(view, { host, port }, token) {
  try {
    const url = await view.listen(port, host);
    console.error(`jev-router: live view on ${viewUrl(url, token)}`);
    if (!isLoopback(host) && token === undefined)
      console.error(
        `jev-router: the live view listens on ${urlHost(host)}, so anyone who can reach that address can watch routing decisions (models, tiers, costs; never prompts or keys).`,
      );
  } catch (err) {
    console.error(`jev-router: the live view can't listen on ${urlHost(host)}:${port}: ${errorMessage(err)}. Routing goes on without it.`);
  }
}

/** @type {Record<string, 'value' | 'flag'>} */
const LAUNCH_OPTIONS = { '--config': 'value', '--env-file': 'value', '--port': 'value', '--ui': 'value' };
/** @type {Record<string, { bin: string, override: string, spec: Record<string, 'value' | 'flag'> }>} */
const AGENTS = {
  claude: { bin: 'claude', override: 'JEV_ROUTER_CLAUDE_BIN', spec: LAUNCH_OPTIONS },
  codex: { bin: 'codex', override: 'JEV_ROUTER_CODEX_BIN', spec: { ...LAUNCH_OPTIONS, '--force': 'flag' } },
};

/**
 * `jev-router launch claude|codex`: runs the agent through a router and exits with the agent's
 * exit code. With --ui (or JEV_ROUTER_UI), a router it starts also serves the live view.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function launch(args, env) {
  const [name = '', ...rest] = args;
  const agent = Object.hasOwn(AGENTS, name) ? AGENTS[name] : undefined;
  if (!agent)
    throw new Error(
      'Usage: jev-router launch claude|codex [--config <file>] [--env-file <file>] [--port <n>] [--ui [<host>:]<port>] [--] [agent args…]',
    );
  const { values, flags, rest: agentArgs } = parseArgs(rest, agent.spec, { passthrough: true });
  const file = useEnvFile(values['env-file'], env);
  const { cfg, host, port, token } = settings(values, env);
  const uiAddress = parseUiAddress(values.ui ?? envValue(env, 'JEV_ROUTER_UI'));
  const forAgent = agentEnv(env, file);
  const leak = name === 'claude' ? gatewayLeak(forAgent, host, port) : undefined;
  if (leak) {
    console.error(leakMessage(leak, `env ${leak.unset.map((variable) => `-u ${variable}`).join(' ')} jev-router launch claude`));
    return 1;
  }
  const wanted = envValue(env, agent.override) ?? agent.bin;
  const bin = findProgram(wanted, env);
  if (!bin) {
    console.error(`jev-router: cannot find ${wanted}. Install it, or set ${agent.override} to its path.`);
    return 127;
  }
  const uiToken = envValue(env, 'JEV_ROUTER_UI_TOKEN');
  const view = uiAddress ? createUiServer({ token: uiToken }) : undefined;
  const router = await routerFor(cfg, host, port, env, view);
  console.error(
    router.reused
      ? `jev-router: reusing the jev-router ${router.version} at ${router.url}`
      : `jev-router: routing ${name} through ${router.url} (log: ${router.logFile})`,
  );
  if (view && uiAddress && !router.reused) await startView(view, uiAddress, uiToken);
  else if (values.ui && router.reused)
    console.error(
      `jev-router: --ui serves a live view only for a router that launch starts. For the one at ${router.url}, open its own view, or follow its log with: jev-router ui`,
    );
  try {
    if (name === 'codex') {
      writeCodexProfile(env, router.url, token, flags.has('force'));
      return await runAgent(bin, ['--profile', 'jev', ...agentArgs], forAgent);
    }
    return await runAgent(bin, agentArgs, { ...forAgent, ...claudeVars(forAgent, router.url, token) });
  } finally {
    await router.stop();
    await view?.close();
  }
}

/**
 * @typedef {object} AgentRouter
 * @property {string} url where the agent sends requests
 * @property {boolean} reused whether it was already running
 * @property {string} [version] the running router's version
 * @property {string} [logFile] where a router started here logs
 * @property {() => Promise<void>} stop
 */
/**
 * The file that marks a router as belonging to a running `launch`.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} port
 */
const ownerFile = (env, port) => join(dirname(routerLogPath(env)), `launch-${port}.pid`);

/**
 * Whether the router on `port` belongs to another `launch`. That router stops when its own agent
 * exits, so a second session must not lean on it.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} port
 */
function ownedByLaunch(env, port) {
  try {
    process.kill(Number(readFileSync(ownerFile(env, port), 'utf8')), 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM'; // alive, just not ours to signal; no file or no such process means no owner
  }
}

/**
 * @typedef {object} Leak another gateway's credentials that Claude Code would carry through the router to Anthropic
 * @property {string} base the gateway's base URL, from this shell
 * @property {Credential[]} credentials
 * @property {string[]} unset the shell's variables to leave out
 * @property {Credential[]} inSettings credentials in the settings file, to remove there
 */

/**
 * The credentials Claude Code would carry to the router, when this shell sends it to another
 * gateway with them: behind the router they'd go to Anthropic. Without another gateway, they're
 * Anthropic's own, and fine.
 * @param {NodeJS.ProcessEnv} shell what Claude Code starts with
 * @param {string} host
 * @param {number} port
 * @returns {Leak | undefined}
 */
function gatewayLeak(shell, host, port) {
  const base = envValue(shell, 'ANTHROPIC_BASE_URL');
  if (!base || !foreignBaseUrl(base, { host, port })) return undefined;
  const file = claudeSettingsPath(shell);
  const read = readSettings(file);
  const credentials = claudeCredentials(shell, 'problem' in read ? {} : read.data, file);
  if (!credentials.length) return undefined;
  const unset = ['ANTHROPIC_BASE_URL', ...credentials.filter((c) => c.where === 'this shell').map((c) => c.name)];
  return { base, credentials, unset, inSettings: credentials.filter((c) => c.where !== 'this shell') };
}

/**
 * Why `launch claude` or `env claude` refuses, and the command that leaves those credentials out.
 * @param {Leak} leak
 * @param {string} way
 */
function leakMessage({ base, credentials, inSettings }, way) {
  const settings = inSettings.length ? `remove ${credentialsInWords(inSettings)}, then ` : '';
  return (
    `jev-router: this shell sends Claude Code to ${base} (ANTHROPIC_BASE_URL), with ${credentialsInWords(credentials)}. ` +
    `Through the router, Claude Code would send those credentials to Anthropic. To leave them out, ${settings}run: ${way}`
  );
}

/**
 * Finds the router the agent should use: one that already answers at host:port, or a new one in
 * this process on loopback. The new one logs to files only, because the agent's TUI owns the
 * terminal, and to the live view, when there is one.
 * @param {Config} cfg
 * @param {string} host
 * @param {number} port
 * @param {NodeJS.ProcessEnv} env
 * @param {UiServer} [view] gets every entry a router started here logs
 * @returns {Promise<AgentRouter>}
 */
async function routerFor(cfg, host, port, env, view) {
  const url = `http://${clientHost(host)}:${port}`;
  const found = port === 0 ? undefined : await probe(url); // port 0 asks for any free port, so there's nothing to find
  if (found?.health && !ownedByLaunch(env, port)) return { url, reused: true, version: found.health.version, stop: async () => undefined };
  const logFile = routerLogPath(env);
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const log = logger(() => ({ files: [logFile, cfg.logFile], maxBytes: cfg.logMaxBytes }), {
    echo: view && ((entry) => view.publish(entry)),
  });
  const server = createRouter({ ...cfg, host: LOOPBACK, port }, { log });
  let bound;
  try {
    bound = await listen(server, port, LOOPBACK);
  } catch (err) {
    // Something else holds the port: another program, or another session's router. Any free port
    // works, because the agent is handed the URL.
    if (!['EADDRINUSE', 'EACCES'].includes(errorCode(err) ?? '')) throw err;
    bound = await listen(server, 0, LOOPBACK);
  }
  logConfig(log, cfg);
  const owner = ownerFile(env, bound);
  writeFileSync(owner, String(process.pid), { mode: 0o600 });
  const stop = async () => {
    await stopRouter(server);
    rmSync(owner, { force: true });
  };
  return { url: `http://${LOOPBACK}:${bound}`, reused: false, logFile, stop };
}

/**
 * Stops a router this process started: no new connections, up to 5 s for requests in flight, then close.
 * @param {RouterServer} server
 */
async function stopRouter(server) {
  const closed = new Promise((done) => server.close(done));
  const deadline = Date.now() + 5000;
  while (server.active > 0 && Date.now() < deadline) await sleep(50);
  server.closeAllConnections();
  await closed;
}

/**
 * Runs the agent in the foreground. Resolves with its exit code, or 128 + the signal number that ended it.
 * @param {string} bin
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function runAgent(bin, args, env) {
  return new Promise((done) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    const ignore = () => {
      // Ctrl-C reaches the whole foreground process group, and the agent handles it itself (Claude
      // Code interrupts the turn). Exiting here would pull the router out from under it.
    };
    /** @param {NodeJS.Signals} signal */
    const forward = (signal) => {
      child.kill(signal);
    };
    process.on('SIGINT', ignore);
    process.on('SIGTERM', forward);
    process.on('SIGHUP', forward);
    let settled = false;
    /** @param {number} code */
    const finish = (code) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', ignore);
      process.off('SIGTERM', forward);
      process.off('SIGHUP', forward);
      done(code);
    };
    child.on('error', (err) => {
      console.error(`jev-router: cannot run ${bin}: ${err.message}`);
      finish(errorCode(err) === 'ENOENT' ? 127 : 126);
    });
    child.on('exit', (code, signal) => finish(code ?? 128 + (signal ? osConstants.signals[signal] : 0)));
  });
}

/**
 * A TOML basic string. JSON's escapes are valid TOML; DEL is the one character TOML also wants escaped.
 * @param {string} value
 */
const tomlString = (value) => JSON.stringify(value).replaceAll('\u007f', '\\u007f');

/**
 * The Codex profile for a router at `url`, from the packaged example with its placeholders filled in.
 * @param {string} url
 * @param {string | undefined} token
 */
function codexProfile(url, token) {
  const header = token ? `\nhttp_headers = { ${tomlString(TOKEN_HEADER)} = ${tomlString(token)} }` : '';
  const text = readFileSync(CODEX_TEMPLATE, 'utf8')
    .replace(/^model_catalog_json = .*$/m, () => `model_catalog_json = ${tomlString(CODEX_MODELS)}`)
    .replace(/^base_url = .*$/m, () => `base_url = ${tomlString(`${url}/v1`)}${header}`);
  return `# Written by \`jev-router launch codex\`, which leaves the file alone once you edit it (--force rewrites it).\n${text}`;
}

/**
 * Whether `text` is a profile this command wrote that nobody has edited since, whatever router URL
 * and token it names. Such a file follows the router when its port or token changes.
 * @param {string} text
 */
function isOwnProfile(text) {
  const url = /^base_url = (".*")$/m.exec(text)?.[1];
  const token = /^http_headers = \{ "x-jev-router-token" = (".*") \}$/m.exec(text)?.[1];
  try {
    return url !== undefined && text === codexProfile(JSON.parse(url).replace(/\/v1$/, ''), token && JSON.parse(token));
  } catch {
    return false; // not a TOML string we wrote
  }
}

/**
 * Writes $CODEX_HOME/jev.config.toml. An edited file stays as it is unless `force` is set.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} url
 * @param {string | undefined} token
 * @param {boolean} force
 */
function writeCodexProfile(env, url, token, force) {
  const path = codexProfilePath(env);
  const text = codexProfile(url, token);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (current === text) return;
  if (current !== undefined && !force && !isOwnProfile(current)) {
    console.error(`jev-router: kept ${path} because it was edited. Pass --force to replace it with the profile for ${url}/v1.`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600); // the profile may hold the router token
}

/**
 * `jev-router env claude|codex`: prints what a shell needs to use the router, without starting one.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function printEnv(args, env) {
  const { values, rest } = parseArgs(args, { '--config': 'value', '--env-file': 'value', '--port': 'value' });
  const [agent, ...extra] = rest;
  if (!(agent === 'claude' || agent === 'codex') || extra.length)
    throw new Error('Usage: jev-router env claude|codex [--config <file>] [--env-file <file>] [--port <n>]');
  const file = useEnvFile(values['env-file'], env);
  const { host, port, token } = settings(values, env);
  if (port === 0) throw new Error('env needs the port the router listens on, not 0');
  const leak = agent === 'claude' ? gatewayLeak(agentEnv(env, file), host, port) : undefined;
  if (leak) {
    console.error(leakMessage(leak, `unset ${leak.unset.join(' ')}; eval "$(jev-router env claude)"`));
    return 1;
  }
  const url = `http://${clientHost(host)}:${port}`;
  const lines =
    agent === 'claude'
      ? Object.entries(claudeVars(env, url, token)).map(([name, value]) => `export ${name}=${shellQuote(value)}`)
      : codexHelp(env, url);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!(await probe(url)).health) console.error(`jev-router: nothing answers at ${url} yet. Start a router with: jev-router serve`);
  return 0;
}

/**
 * Codex takes the router from a profile, not from the environment, so `env codex` explains that in comments a shell ignores.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} url
 */
function codexHelp(env, url) {
  const profile = codexProfilePath(env);
  return [
    '# Codex reads the router from a profile, not from environment variables.',
    `# Profile: ${profile} (${existsSync(profile) ? 'exists' : 'not written yet: `jev-router launch codex` writes it'})`,
    `# Router:  ${url}/v1`,
    '# Run:     codex --profile jev',
  ];
}

/**
 * `jev-router doctor`: a checklist of what routing needs. It exits 1 when the config is invalid, no
 * Jev channel has a key, or a --live call fails. It names environment variables, never their values.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function doctor(args, env) {
  const { values, flags, rest } = parseArgs(args, { '--config': 'value', '--env-file': 'value', '--live': 'flag' });
  if (rest.length) throw new Error('Usage: jev-router doctor [--config <file>] [--env-file <file>] [--live]');
  const list = checklist();
  const file = checkEnvFile(list, values['env-file'], env); // first: it can hold the keys and the settings below
  const cfg = checkConfig(list, values.config, env);
  const major = Number(process.versions.node.split('.')[0]);
  list.add(major >= 22 ? 'ok' : 'warn', 'node', major >= 22 ? process.version : `${process.version}: jev-router needs Node 22 or newer`);
  if (cfg) {
    checkJevKeys(list, cfg, env);
    checkUpstreams(list, cfg, env);
    checkLogFile(list, cfg, env);
  }
  checkProxy(list, env, file?.names ?? []);
  const router = await checkRouter(list, cfg, env);
  const service = checkService(list, env, router);
  const claude = cfg ? checkClaudeCode(list, cfg, env) : undefined;
  if (cfg && flags.has('live')) await checkLive(list, cfg, env);
  const always = service && claude === 'settings'; // the service answers, and every Claude Code session uses it
  const verdict = list.failed
    ? 'Not ready: fix the FAIL lines above.'
    : `Ready. ${always ? 'Start Claude Code as usual: claude' : 'Start a session with: jev-router launch claude'}`;
  process.stdout.write(`jev-router ${VERSION} doctor\n${list.lines.join('\n')}\n\n${verdict}\n`);
  return list.failed ? 1 : 0;
}

/** @returns {Checklist} */
function checklist() {
  /** @type {string[]} */
  const lines = [];
  let failed = false;
  return {
    lines,
    get failed() {
      return failed;
    },
    add(status, topic, text) {
      failed ||= status === 'FAIL';
      lines.push(`  ${status.padEnd(5)}${topic.padEnd(10)}${text.replaceAll('\n', `\n${' '.repeat(17)}`)}`);
    },
  };
}

/**
 * The env file every other command would load (--env-file, JEV_ROUTER_ENV_FILE or the standard
 * file), loaded so that the key checks see what a router started with it sees.
 * @param {Checklist} list
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {EnvFile | undefined} the file loaded, if any
 */
function checkEnvFile(list, flag, env) {
  let file;
  try {
    file = loadEnvFile(flag, env);
  } catch (err) {
    list.add('FAIL', 'env-file', errorMessage(err));
    return undefined;
  }
  if (!file) return undefined;
  const sets = file.names.length ? `sets ${file.names.join(', ')}` : 'sets nothing: its variables are all set already, and those win';
  list.add('ok', 'env-file', `${file.path} (${file.source}) ${sets}`);
  for (const warning of file.warnings) list.add('warn', 'env-file', warning);
  return file;
}

/**
 * The log file serve writes besides stdout: its directory has to exist, unless serve creates it.
 * @param {Checklist} list
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 */
function checkLogFile(list, cfg, env) {
  const named = namedLogFile(undefined, env);
  const file = named ?? cfg.logFile;
  if (!file) return;
  const source = named ? 'JEV_ROUTER_LOG_FILE' : 'logFile';
  const rotation = cfg.logMaxBytes ? `rotates at ${sizeInWords(cfg.logMaxBytes)}` : 'never rotates (logMaxBytes is 0)';
  const dir = dirname(file);
  if (!existsSync(dir)) {
    if (named) list.add('ok', 'log', `${file} (${source}): serve creates ${dir}; ${rotation}`);
    else list.add('warn', 'log', `${file} (${source}): ${dir} doesn't exist, so nothing is logged there. Create it, or change logFile.`);
  } else if (!canWrite(existsSync(file) ? file : dir)) list.add('warn', 'log', `${file} (${source}): the router can't write it`);
  else list.add('ok', 'log', `${file} (${source}); ${rotation}`);
}

/** @param {number} bytes */
const sizeInWords = (bytes) => (bytes % 1048576 === 0 ? `${bytes / 1048576} MiB` : `${bytes} bytes`);

/** @param {string} path */
function canWrite(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude Code pointed at the router, from this shell or its settings file, without the settings
 * that `launch` would set. Nothing is said when it isn't pointed at the router.
 * @param {Checklist} list
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 * @returns {'settings' | 'shell' | undefined} where Claude Code gets the router's address from, if anywhere
 */
function checkClaudeCode(list, cfg, env) {
  const file = claudeSettingsPath(env);
  const saved = settingsEnv(file);
  /** @param {string} name */
  const value = (name) => saved[name] ?? envValue(env, name);
  const base = value('ANTHROPIC_BASE_URL');
  if (!base || !pointsAtRouter(base, cfg, env)) return undefined;
  const where = saved.ANTHROPIC_BASE_URL ? file : 'this shell';
  const leak = gatewayLeak(env, envValue(env, 'JEV_ROUTER_HOST') ?? cfg.host, Number(envValue(env, 'JEV_ROUTER_PORT') ?? cfg.port));
  if (leak) {
    list.add(
      'FAIL',
      'claude',
      `Claude Code uses the router (ANTHROPIC_BASE_URL in ${where}), and this shell also sends it to ${leak.base} with ` +
        `${credentialsInWords(leak.credentials)}: through the router, those credentials go to Anthropic. ` +
        'Remove them from your shell, or take the router out of Claude Code with: jev-router uninstall',
    );
    return saved.ANTHROPIC_BASE_URL ? 'settings' : 'shell';
  }
  const missing = Object.entries(CLAUDE_SETTINGS).filter(([name]) => !value(name));
  if (!missing.length)
    list.add('ok', 'claude', `Claude Code uses the router (ANTHROPIC_BASE_URL in ${where}) with the gateway settings it needs`);
  for (const [name, [wanted, why]] of missing)
    list.add(
      'hint',
      'claude',
      `Claude Code uses the router (ANTHROPIC_BASE_URL in ${where}), but ${name} is not set: ${why}. Set ${name}=${wanted}.`,
    );
  return saved.ANTHROPIC_BASE_URL ? 'settings' : 'shell';
}

/**
 * @param {Checklist} list
 * @param {string | undefined} flag
 * @param {NodeJS.ProcessEnv} env
 * @returns {Config | undefined}
 */
function checkConfig(list, flag, env) {
  const { path, source } = configFile(flag, env);
  try {
    const cfg = loadConfig(path);
    list.add('ok', 'config', `${path} (${source})`);
    return cfg;
  } catch (err) {
    list.add('FAIL', 'config', `${path} (${source})\n${errorMessage(err)}`);
    return undefined;
  }
}

/**
 * @param {Checklist} list
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 */
function checkJevKeys(list, cfg, env) {
  for (const { name, keyEnv, baseUrl, model } of cfg.jev.channels) {
    if (!keyEnv) list.add('ok', 'jev', `${name}: local channel at ${baseUrl}, model ${model}, no key`);
    else list.add(env[keyEnv] ? 'ok' : 'warn', 'jev', `${name}: ${keyEnv} is ${env[keyEnv] ? 'set' : 'not set'}`);
  }
  if (env.JEV_BASE_URL && env.JEV_API_KEY) list.add('ok', 'jev', 'env: JEV_BASE_URL and JEV_API_KEY are set, so this channel goes first');
  else if (env.JEV_BASE_URL && isLoopbackBaseUrl(env.JEV_BASE_URL))
    list.add('ok', 'jev', `env: JEV_BASE_URL is a local channel, model ${env.JEV_MODEL || 'nimble'}, no key`);
  else if (env.JEV_BASE_URL)
    list.add('warn', 'jev', 'env: JEV_BASE_URL is ignored: without JEV_API_KEY it is used only on a loopback address');
  if (!new JevClient(cfg.jev, env).configured) {
    const keys =
      cfg.jev.channels
        .map((ch) => ch.keyEnv)
        .filter(Boolean)
        .join(' or ') || 'JEV_BASE_URL on a loopback address';
    list.add('FAIL', 'jev', `no Jev channel has a key, so every session would get the default tier "${cfg.defaultTier}". Set ${keys}.`);
  }
}

/**
 * Upstream keys, grouped by variable: many targets share one.
 * @param {Checklist} list
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 */
function checkUpstreams(list, cfg, env) {
  /** @type {Map<string, { targets: string[], stranded: string[] }>} */
  const byKey = new Map();
  for (const [surface, targets] of Object.entries(cfg.surfaces)) {
    for (const [tier, target] of Object.entries(targets)) {
      const group = byKey.get(target.keyEnv ?? '') ?? { targets: [], stranded: [] };
      group.targets.push(`${surface}.${tier}`);
      if (!target.clientAuth) group.stranded.push(`${surface}.${tier}`);
      byKey.set(target.keyEnv ?? '', group);
    }
  }
  for (const [key, { targets, stranded }] of byKey) {
    const unset = key ? `${key} is not set` : 'no key configured';
    if (key && env[key]) list.add('ok', 'upstream', `${key} is set: ${targets.join(', ')}`);
    else if (!stranded.length) list.add('ok', 'upstream', `${unset}: ${targets.join(', ')} pass the client's own login through`);
    else list.add('warn', 'upstream', `${unset}: ${stranded.join(', ')} will fail`);
  }
}

/**
 * @param {Checklist} list
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} fromFile variables the env file set: a proxy there never works, and its own line says so
 */
function checkProxy(list, env, fromFile) {
  const proxy = ['HTTPS_PROXY', 'https_proxy'].find((name) => env[name] && !fromFile.includes(name));
  if (!proxy) return;
  if (env.NODE_USE_ENV_PROXY === '1') list.add('ok', 'proxy', `${proxy} is set and NODE_USE_ENV_PROXY=1, so Jev and upstream calls use it`);
  else list.add('hint', 'proxy', `${proxy} is set, but Node ignores it without NODE_USE_ENV_PROXY=1`);
}

/**
 * @param {Checklist} list
 * @param {Config | undefined} cfg
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ url: string, health?: Health } | undefined>} where the router should answer, and what it said
 */
async function checkRouter(list, cfg, env) {
  let url;
  try {
    const host = envValue(env, 'JEV_ROUTER_HOST') ?? cfg?.host ?? LOOPBACK;
    url = `http://${clientHost(host)}:${parsePort(envValue(env, 'JEV_ROUTER_PORT') ?? cfg?.port ?? 4000)}`;
  } catch (err) {
    list.add('FAIL', 'router', errorMessage(err));
    return undefined;
  }
  const { answered, health } = await probe(url);
  if (health) {
    const channels = Object.entries(health.jev.channels).map(
      ([name, s]) => `${name} ${s.open ? `failing (${s.lastError})` : (s.warmup ?? 'ok')} (${s.calls} calls, ${s.errors} errors)`,
    );
    const jev = health.jev.configured ? channels.join(', ') : 'no channel has a key';
    list.add(
      'ok',
      'router',
      `jev-router ${health.version} answers at ${url} (up ${health.uptime_s} s, ${health.sessions} sessions); Jev: ${jev}`,
    );
  } else if (answered) list.add('warn', 'router', `something answers at ${url}, but it is not a jev-router`);
  else list.add('info', 'router', `nothing answers at ${url}; start one with: jev-router serve`);
  return { url, health };
}

/**
 * The background service that setup installs: none, or which one, and whether its router answers.
 * @param {Checklist} list
 * @param {NodeJS.ProcessEnv} env
 * @param {{ url: string, health?: Health } | undefined} router
 * @returns {boolean} whether a service is installed and the router answers
 */
function checkService(list, env, router) {
  const found = installedServices(env, readManifest(env)?.service);
  if (!found.length) list.add('info', 'service', 'none installed; jev-router setup installs one');
  for (const { manager, file } of found) {
    if (router?.health) list.add('ok', 'service', `${MANAGER_NAMES[manager]} ${file}; the router answers at ${router.url}`);
    else
      list.add(
        'warn',
        'service',
        `${MANAGER_NAMES[manager]} ${file}, but nothing answers at ${router?.url ?? 'its address'}. See ${logHint(manager)}`,
      );
  }
  return found.length > 0 && Boolean(router?.health);
}

/**
 * One real decision call with a small state in the shape the router sends. A hosted call costs about
 * $0.00003. A local channel costs nothing. The line says which model answered.
 * @param {Checklist} list
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 */
async function checkLive(list, cfg, env) {
  const client = new JevClient(cfg.jev, env);
  if (!client.configured) {
    list.add('info', 'live', 'skipped: no Jev channel has a key');
    return;
  }
  const answer = await client.decide(SAMPLE_STATE, { warmOnTimeout: false });
  client.close();
  if (answer.ok) list.add('ok', 'live', `${answer.channel} answered in ${answer.ms} ms with ${answer.model} (choice: ${answer.choice})`);
  else list.add('FAIL', 'live', `no answer after ${answer.ms} ms: ${answer.error}`);
}

/**
 * `jev-router init`: copies a packaged config to the user config path, the one --models names, else
 * the packaged default. `--anthropic-only`, from before `--models`, is `--models claude`.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function init(args, env) {
  const { values, flags, rest } = parseArgs(args, { '--models': 'value', '--anthropic-only': 'flag', '--force': 'flag' });
  if (rest.length) throw new Error(`Usage: jev-router init [--models ${MODEL_CHOICES.join('|')}] [--force]`);
  const named = modelsFlag(values.models);
  if (named && named !== 'claude' && flags.has('anthropic-only'))
    throw new Error(`--anthropic-only is --models claude, not --models ${named}`);
  const source = PACKAGED_CONFIGS[named ?? (flags.has('anthropic-only') ? 'claude' : 'ollama')];
  const target = userConfigPath(env);
  const inside = inPackage(target);
  if (inside) {
    console.error(`jev-router: ${target} leads into jev-router's own files (${inside}). Remove it first: rm ${shellQuote(target)}`);
    return 1;
  }
  if (existsSync(target) && !flags.has('force')) {
    console.error(`jev-router: ${target} already exists. Pass --force to overwrite it.`);
    return 1;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileSync(source), { mode: 0o600 });
  chmodSync(target, 0o600); // an overwritten file keeps its old mode otherwise, and the config may hold a token
  process.stdout.write(`Wrote ${target} from the packaged ${basename(source)}.\nNext: set your Jev key, then run: jev-router doctor\n`);
  return 0;
}

/**
 * `jev-router report [log]`: requests, spend and savings from a router log. Without an argument it
 * reads JEV_ROUTER_LOG_FILE, else the config's logFile, else the log that `launch` writes, with the
 * lines its last rotation kept.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function printReport(args, env) {
  const { values, rest } = parseArgs(args, { '--config': 'value' });
  if (rest.length > 1) throw new Error('Usage: jev-router report [<log.jsonl>]');
  const [named] = rest;
  const launched = routerLogPath(env);
  const file =
    named ??
    namedLogFile(undefined, env) ??
    loadConfig(configFile(values.config, env).path).logFile ??
    (existsSync(launched) ? launched : undefined);
  if (!file) throw new Error('Usage: jev-router report <log.jsonl> (or set JEV_ROUTER_LOG_FILE, or logFile in the config)');
  // The router's own log keeps the lines from before its last rotation in <file>.1.
  const files = named === undefined && existsSync(`${file}.1`) ? [`${file}.1`, file] : [file];
  const lines = files.flatMap((path) => readFileSync(path, 'utf8').split('\n'));
  process.stdout.write(`${JSON.stringify(report(lines), null, 2)}\n`);
  return 0;
}

/**
 * `jev-router ui [log]`: a live view of routing in the browser, on loopback. It follows the log
 * given, else JEV_ROUTER_LOG_FILE, else the config's logFile, else the log that `launch` writes,
 * and waits for a log that doesn't exist yet. With --ui-token or JEV_ROUTER_UI_TOKEN it asks for it.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<undefined>}
 */
async function ui(args, env) {
  const { values, rest } = parseArgs(args, { '--config': 'value', '--port': 'value', '--ui-token': 'value' });
  if (rest.length > 1) throw new Error('Usage: jev-router ui [<log.jsonl>] [--port <n>] [--ui-token <token>]');
  const file = resolve(
    rest[0] ?? namedLogFile(undefined, env) ?? loadConfig(configFile(values.config, env).path).logFile ?? routerLogPath(env),
  );
  const port = values.port === undefined ? UI_PORT : parsePort(values.port);
  const token = values['ui-token'] ?? envValue(env, 'JEV_ROUTER_UI_TOKEN');
  const view = createUiServer({ file, token });
  const url = await view.listen(port).catch((err) => {
    throw new Error(`cannot listen on ${LOOPBACK}:${port}: ${errorMessage(err)}`);
  });
  console.error(
    `jev-router ui: open ${viewUrl(url, token)}\nFollowing ${file}${existsSync(file) ? '' : ' (not there yet: waiting for the router to write it)'}`,
  );
  const stop = () => {
    void view.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return undefined;
}

/** @type {ReadonlyArray<SetupOptions['service']>} */
const SERVICES = ['auto', 'launchd', 'systemd', 'none'];

/**
 * The packaged config `--models` names.
 * @param {string | undefined} value
 * @returns {Models | undefined}
 */
function modelsFlag(value) {
  if (value === undefined) return undefined;
  const models = MODEL_CHOICES.find((name) => name === value);
  if (!models) throw new Error(`--models takes ${inWords([...MODEL_CHOICES], 'or')}, got "${value}"`);
  return models;
}

/**
 * `jev-router setup`: see `runSetup` in setup.mjs.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function setup(args, env) {
  const { values, flags, rest } = parseArgs(args, {
    '--yes': 'flag',
    '-y': 'flag',
    '--models': 'value',
    '--service': 'value',
    '--no-claude-settings': 'flag',
  });
  if (rest.length)
    throw new Error(
      `Usage: jev-router setup [--yes] [--models ${MODEL_CHOICES.join('|')}] [--service auto|launchd|systemd|none] [--no-claude-settings]`,
    );
  const service = SERVICES.find((name) => name === (values.service ?? 'auto'));
  if (!service) throw new Error(`--service takes auto, launchd, systemd or none, got "${values.service}"`);
  const models = modelsFlag(values.models);
  return runSetup({ yes: flags.has('yes') || flags.has('y'), service, claudeSettings: !flags.has('no-claude-settings'), models }, env);
}

/**
 * `jev-router uninstall`: see `runUninstall` in setup.mjs.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function uninstall(args, env) {
  if (args.length) throw new Error('Usage: jev-router uninstall');
  return runUninstall(env);
}

const printVersion = () => {
  process.stdout.write(`${VERSION}\n`);
  return 0;
};

const printHelp = () => {
  process.stdout.write(HELP);
  return 0;
};

/** @type {Record<string, (args: string[], env: NodeJS.ProcessEnv) => Promise<number | undefined> | number>} */
const COMMANDS = {
  setup,
  uninstall,
  serve,
  launch,
  env: printEnv,
  doctor,
  init,
  report: printReport,
  ui,
  version: printVersion,
  '--version': printVersion,
  help: printHelp,
  '--help': printHelp,
  '-h': printHelp,
};
