// `jev-router setup` gets a plain Mac or Linux machine routing. It asks which models Claude Code
// uses and for the keys they need, checks the Jev key with one call, and only then writes: the
// config, the env file, a launchd or systemd service, and, once the router answers, Claude Code's
// settings. It is safe to run again. `jev-router uninstall` (uninstall.mjs) undoes it from the
// manifest setup keeps.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  changeSettingsEnv,
  claudeCredentials,
  claudeVars,
  credentialsInWords,
  foreignBaseUrl,
  hasTokenLine,
  readSettings,
  recordedValues,
  settingsBlock,
  settingsSet,
  writeSettings,
} from './claude.mjs';
import { loadConfig } from './config.mjs';
import { agentEnv, envFilePath, loadEnvFile, looseFile, readEnvFile, saveEnvValues } from './envfile.mjs';
import {
  claudeSettingsPath,
  configFile,
  envValue,
  errorCode,
  errorMessage,
  hasControlCharacter,
  inPackage,
  MODEL_CHOICES,
  NO_ENV_FILE,
  namedLogFile,
  PACKAGED_CONFIGS,
  packaged,
  packagedModels,
  routerLogPath,
  setupManifestPath,
  shellQuote,
  userConfigPath,
  writeFileAtomic,
} from './files.mjs';
import {
  commandVersion,
  globalCommand,
  installedCommand,
  LEGACY_PACKAGE,
  legacyInstall,
  npmInstall,
  origin,
  sameFile,
} from './install.mjs';
import { JevClient, SAMPLE_STATE } from './jev.mjs';
import { clientHost, isLoopback, parsePort, parseUiAddress, portProblem, probe, UI_PORT } from './net.mjs';
import { PromptAbort, Prompter } from './prompt.mjs';
import { VERSION } from './router.mjs';
import {
  chooseManager,
  installedServices,
  launchdErrorLog,
  logHint,
  MANAGER_NAMES,
  renderService,
  serviceFile,
  startService,
} from './service.mjs';

/** @import { Config, JevChannel, Models } from './types.js' */
/** @import { Credential, SettingsChange } from './claude.mjs' */
/** @import { Origin } from './install.mjs' */
/** @import { Manager, ManagerChoice } from './service.mjs' */

/**
 * @typedef {object} SetupOptions
 * @property {boolean} yes answer every question with its default, and take the keys from the environment
 * @property {'auto' | Manager | 'none'} service
 * @property {boolean} claudeSettings whether to point Claude Code's settings at the router
 * @property {Models} [models] the packaged config to use, for a machine without a config or with an unchanged packaged one
 */

/**
 * @typedef {object} Manifest what setup changed, for uninstall; it holds no secrets
 * @property {{ manager: Manager, file: string }} [service]
 * @property {{ config: string, env: string, log: string }} [files]
 * @property {{ file: string, created?: boolean, env: Record<string, { value: string, previous?: string }>, tokenHeader?: 'created' | 'added' }} [claude]
 *   `created`: setup made the settings file, so uninstall may remove it once it's empty again
 */

/**
 * @typedef {object} Gateway another gateway Claude Code goes to, and the credentials it sends there
 * @property {string} file Claude Code's settings file
 * @property {Array<{ url: string, where: string }>} bases base URLs, in settings or this shell, that lead elsewhere
 * @property {Credential[]} credentials what Claude Code would carry to the router, and the router to Anthropic
 */

/** @type {Record<Models, { what: string, short: string, needs: string }>} */
const MODELS = {
  claude: { what: 'Claude only: Haiku 4.5, Sonnet 5 and Opus 5.5', short: 'Claude only', needs: 'a Jev key' },
  fable: {
    what: 'Claude only, with Fable 5.1 for deep work: Haiku 4.5, Sonnet 5, Opus 5.5 and Fable 5.1',
    short: 'Claude with Fable 5.1',
    needs: 'a Jev key',
  },
  ollama: {
    what: "Ollama Cloud's glm-5.3-flash for quick work, and Claude for the rest",
    short: 'Ollama Cloud and Claude',
    needs: 'a Jev key and an Ollama key',
  },
};
/** @type {Record<string, string>} */
const KEY_NAMES = { TYPESAFE_API_KEY: 'TypeSafe', OPENROUTER_API_KEY: 'OpenRouter', OLLAMA_API_KEY: 'Ollama', OPENAI_API_KEY: 'OpenAI' };
/** @type {Record<string, string>} */
const KEY_PLACES = { TYPESAFE_API_KEY: 'console.typesafe.ai', OPENROUTER_API_KEY: 'openrouter.ai', OLLAMA_API_KEY: 'ollama.com' };
/** How long setup waits for the service's router, in seconds; JEV_ROUTER_SETUP_WAIT changes it. */
const WAIT_SECONDS = 15;
/** The router settings a service reads from the env file, so that every command finds the router. */
const ROUTER_VARIABLES = ['JEV_ROUTER_HOST', 'JEV_ROUTER_PORT'];

/** @param {string} text */
const say = (text) => process.stderr.write(text);
/** @param {string} name */
const keyName = (name) => KEY_NAMES[name] ?? name;
/**
 * A channel that names a key. A local loopback channel has none, and setup does not ask for one.
 * @param {JevChannel} channel
 * @returns {channel is JevChannel & { keyEnv: string }}
 */
function hasKeyEnv(channel) {
  return typeof channel.keyEnv === 'string' && channel.keyEnv !== '';
}
/**
 * @param {string[]} items
 * @param {string} [last] the word before the last item
 */
export const inWords = (items, last = 'and') =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`;
/** @param {string[]} items */
const orWords = (items) => inWords(items, 'or');
/**
 * Whether a key can't be right: no key has a space or a control character, and an HTTP header can't carry one.
 * @param {string} value
 */
const oddKey = (value) => /\s/.test(value) || hasControlCharacter(value);

/**
 * @typedef {object} Plan everything setup asked and found, before it writes anything
 * @property {Config} cfg
 * @property {string} configPath
 * @property {Models} [models] the packaged config to write, for a machine without a config or to switch models
 * @property {Models} [replaces] the packaged config that one replaces, unchanged since setup or init wrote it
 * @property {string} envFile
 * @property {Record<string, string>} saved the variables the env file sets now
 * @property {Record<string, string>} keys the keys to save
 * @property {Record<string, string>} routerVariables JEV_ROUTER_HOST and JEV_ROUTER_PORT from this shell, to save
 * @property {string} host
 * @property {number} port
 * @property {string} url
 * @property {string} ui the live view's address, as `--ui` takes it
 * @property {string | undefined} token the router token the service will have
 * @property {string} logFile
 * @property {Origin} origin
 * @property {string} [installed] the global jev-router on PATH, outside npx's cache
 * @property {Gateway} gateway
 * @property {ServicePlan} service
 */
/**
 * @typedef {object} ServicePlan
 * @property {Manager} [manager] unset when there is no service
 * @property {string} why why there is none
 * @property {string} [file]
 * @property {{ problem: string, version?: string }} [busy] something else holds the router's port
 * @property {string} [install] the spec to install globally first
 * @property {string} [command] the global jev-router the service runs
 * @property {{ replaceForeign: boolean } | { skip: string }} [settings] `skip` says why they stay as they are
 */
/** @typedef {{ path: string, onPath: boolean }} Command a global jev-router, and whether it's on PATH */
/**
 * @typedef {object} SettingsOutcome what happened to Claude Code's settings
 * @property {string} text
 * @property {boolean} pointed whether Claude Code uses the router now
 * @property {boolean} [changed] whether the settings file changed
 */

/**
 * Why setup and uninstall won't run as root on someone else's behalf: through sudo, or with another
 * user's HOME, they would leave files owned by root in that user's home, and a service in the
 * wrong user's session.
 * @param {{ uid?: number, sudoUid?: string, homeOwner?: number }} who the process's user id, SUDO_UID, and who owns HOME
 * @returns {string | undefined} the problem, or undefined when there's none
 */
export function rootProblem({ uid, sudoUid, homeOwner }) {
  if (uid !== 0) return undefined;
  if (sudoUid) return 'it runs as root through sudo';
  if (homeOwner !== undefined && homeOwner !== 0) return 'it runs as root, but HOME belongs to another user';
  return undefined;
}

/**
 * The message that stops setup or uninstall as root on someone else's behalf, if this is that case.
 * @param {string} command `setup` or `uninstall`
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
export function refuseRoot(command, env) {
  let homeOwner;
  try {
    homeOwner = statSync(homedir()).uid;
  } catch {
    // no HOME to own: the other checks decide
  }
  const problem = rootProblem({ uid: process.getuid?.(), sudoUid: envValue(env, 'SUDO_UID'), homeOwner });
  if (!problem) return undefined;
  return (
    `jev-router: ${command} won't run here: ${problem}, so it would leave files owned by root in your home. ` +
    `Run it as your own user, without sudo: jev-router ${command}\n`
  );
}

/**
 * `jev-router setup`: asks, checks the Jev key, then writes. Returns the exit code.
 * @param {SetupOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export async function runSetup(options, env) {
  const refusal = refuseRoot('setup', env) ?? refuseNoEnvFile(env);
  if (refusal) {
    say(refusal);
    return 1;
  }
  const prompter = options.yes ? undefined : new Prompter(process.stdin, process.stderr);
  const stop = new AbortController();
  const interrupt = () => {
    prompter?.interrupt();
    stop.abort();
  };
  process.on('SIGINT', interrupt);
  let plan;
  try {
    say(`jev-router ${VERSION} setup\n\n`);
    plan = await ask(options, env, prompter, stop.signal);
    // Ctrl-C after the last question still means nothing gets written.
    if (stop.signal.aborted) throw new PromptAbort('interrupted', 130);
  } catch (err) {
    if (!(err instanceof PromptAbort)) throw err;
    say(
      err.exitCode === 130
        ? '\nStopped. Nothing was written.\n'
        : `\nSetup needs answers, but ${err.message}. Nothing was written. Run it in a terminal, or pass --yes with the keys in the environment.\n`,
    );
    return err.exitCode;
  } finally {
    process.off('SIGINT', interrupt);
    prompter?.close();
  }
  // From here the first write comes before anything else can run, so a Ctrl-C can't split it.
  return plan ? carryOut(plan, env) : 1;
}

/**
 * The message for JEV_ROUTER_ENV_FILE=/dev/null, which turns the env file off: setup has nowhere to save the keys.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined}
 */
function refuseNoEnvFile(env) {
  if (envFilePath(env) !== NO_ENV_FILE) return undefined;
  return `jev-router: JEV_ROUTER_ENV_FILE is ${NO_ENV_FILE}, which turns the env file off, so setup has nowhere to save the keys. Unset it, then run setup again.\n`;
}

/**
 * Everything that needs an answer, in order: the models, the keys and their check, the service,
 * a global install, and a base URL Claude Code has already. Nothing is written here.
 * @param {SetupOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter undefined with --yes
 * @param {AbortSignal} signal
 * @returns {Promise<Plan | undefined>} undefined when the Jev key didn't work under --yes
 */
async function ask(options, env, prompter, signal) {
  const envFile = envFilePath(env);
  const loaded = existsSync(envFile) ? loadEnvFile(undefined, env) : undefined;
  for (const warning of loaded?.warnings ?? []) say(`note: ${warning}\n`);
  const { values: saved } = readEnvFile(envFile);
  const choice = chooseManager(options.service, env);
  if (!choice.manager && options.service !== 'auto' && options.service !== 'none')
    throw new Error(`--service ${options.service}: ${choice.why}`);
  const { cfg, configPath, models, replaces } = await chooseConfig(options, env, prompter);
  const router = routerPlan(cfg, env, saved);
  const odd = [configPath, envFile, router.logFile].find(hasControlCharacter);
  if (odd !== undefined) throw new Error(`setup can't put ${JSON.stringify(odd)} in a service file: it has a control character`);
  const keys = await collectKeys({ cfg, env, saved, prompter, signal });
  if (!keys) return undefined;
  // What Claude Code starts with: the shell's variables, without the ones the env file added for the router.
  const gateway = gatewayCheck(router, env, agentEnv(env, loaded));
  /** @type {Plan} */
  const plan = {
    ...router,
    cfg,
    configPath,
    models,
    replaces,
    envFile,
    saved,
    keys,
    origin: origin(VERSION),
    gateway,
    service: choice,
  };
  plan.installed = installedCommand(env);
  if (choice.manager) plan.service = await planService(plan, choice, options, env, prompter);
  return plan;
}

/**
 * The config to use. A machine without one gets the packaged config for the models the person
 * picks, and so does a user config that is still an unchanged copy of a packaged one: that's how a
 * second run switches models. Any other config stays as it is.
 * @param {SetupOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter
 * @returns {Promise<Pick<Plan, 'cfg' | 'configPath' | 'models' | 'replaces'>>}
 */
async function chooseConfig(options, env, prompter) {
  const found = configFile(undefined, env);
  const user = found.source === 'user config';
  const inside = user ? inPackage(found.path) : undefined;
  const current = user && !inside ? packagedModels(found.path) : undefined;
  if (found.source !== 'packaged default' && !current) {
    say(`Config: ${found.path} (${found.source}), kept as it is${keptNote(found, options.models, inside)}.\n\n`);
    return { cfg: loadConfig(found.path), configPath: found.path };
  }
  const models = options.models ?? (prompter ? await askModels(prompter, current) : (current ?? 'claude'));
  say(prompter && !options.models ? '\n' : `Models: ${MODELS[models].what}.\n\n`);
  if (models === current) return { cfg: loadConfig(found.path), configPath: found.path };
  return { cfg: loadConfig(PACKAGED_CONFIGS[models]), configPath: userConfigPath(env), models, replaces: current };
}

/**
 * Why setup keeps a config as it is, and how to change it.
 * @param {{ path: string, source: string }} found the config, and where it came from, as `configFile` says
 * @param {Models | undefined} models what --models asked for
 * @param {string | undefined} inside where the config leads, when that's inside jev-router's package
 */
function keptNote(found, models, inside) {
  if (found.source !== 'user config') return models ? `; --models doesn't change a config that ${found.source} names` : '';
  if (inside)
    return (
      `: it leads into jev-router's own files (${inside}), which setup never changes. ` +
      `To pick models, remove it (rm ${shellQuote(found.path)}), then run setup again`
    );
  const from = models ? `the packaged ${models} config` : 'a packaged one';
  return (
    ": it isn't one of the packaged configs. " +
    `To start over from ${from}, run jev-router init --models ${models ?? MODEL_CHOICES.join('|')} --force, then setup again`
  );
}

/**
 * @param {Prompter} prompter
 * @param {Models | undefined} current the packaged config the machine has now, which Enter keeps
 * @returns {Promise<Models>}
 */
async function askModels(prompter, current) {
  const fallback = current ?? 'claude';
  const numbers = MODEL_CHOICES.map((_, i) => String(i + 1));
  prompter.say(
    `Which models should Claude Code use?${current ? ' Enter keeps the ones you have.' : ''}\n` +
      MODEL_CHOICES.map((name, i) => `  ${numbers[i]}. ${MODELS[name].what}. You need ${MODELS[name].needs}.\n`).join(''),
  );
  for (;;) {
    const answer = await prompter.ask(`Choose ${orWords(numbers)} [${numbers[MODEL_CHOICES.indexOf(fallback)]}]: `);
    if (answer === '') return fallback;
    const index = numbers.indexOf(answer);
    if (index >= 0) return MODEL_CHOICES[index];
    prompter.say(`Please answer ${orWords(numbers)}.\n`);
  }
}

/**
 * Where the service's router will listen, and what else it will see: the config, overridden by
 * JEV_ROUTER_HOST and JEV_ROUTER_PORT, which go into the env file when this shell sets them, so the
 * service and every other command read the same address; the router token from the env file or the
 * config, the only places a service reads it from.
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, string>} saved
 */
function routerPlan(cfg, env, saved) {
  const host = envValue(env, 'JEV_ROUTER_HOST') ?? cfg.host;
  const port = parsePort(envValue(env, 'JEV_ROUTER_PORT') ?? cfg.port);
  if (port === 0) throw new Error('setup needs the port the router listens on, not 0 (JEV_ROUTER_PORT)');
  const ui = envValue(env, 'JEV_ROUTER_UI') ?? String(UI_PORT);
  parseUiAddress(ui); // stops here on a bad value
  const token = (Object.hasOwn(saved, 'JEV_ROUTER_TOKEN') ? saved.JEV_ROUTER_TOKEN : cfg.token) || undefined;
  const logFile = namedLogFile(undefined, env) ?? routerLogPath(env);
  /** @type {Record<string, string>} */
  const routerVariables = {};
  for (const name of ROUTER_VARIABLES) {
    const value = envValue(env, name);
    if (value !== undefined && saved[name] !== value) routerVariables[name] = value;
  }
  return { host, port, url: `http://${clientHost(host)}:${port}`, ui, token, logFile, routerVariables };
}

/**
 * Another gateway that Claude Code goes to, from its settings file or this shell, other than the
 * router, Anthropic, or the router address setup wrote before, and the credentials Claude Code
 * would carry. Behind the router, those credentials would go to Anthropic.
 * @param {{ host: string, port: number }} router
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.ProcessEnv} shell what Claude Code starts with
 * @returns {Gateway}
 */
function gatewayCheck(router, env, shell) {
  const file = claudeSettingsPath(env);
  const read = readSettings(file);
  const data = 'problem' in read ? {} : read.data;
  const own = readManifest(env)?.claude?.env?.ANTHROPIC_BASE_URL?.value;
  const places = [
    { url: settingsBlock(data).ANTHROPIC_BASE_URL, where: file },
    { url: envValue(shell, 'ANTHROPIC_BASE_URL'), where: 'this shell' },
  ];
  const bases = places.filter(
    /** @returns {base is { url: string, where: string }} */ (base) =>
      base.url !== undefined && base.url !== own && foreignBaseUrl(base.url, router),
  );
  return { file, bases, credentials: bases.length ? claudeCredentials(shell, data, file) : [] };
}

/**
 * Whether routing Claude Code would send another gateway's credentials to Anthropic.
 * @param {Gateway} gateway
 */
const leaks = (gateway) => gateway.bases.length > 0 && gateway.credentials.length > 0;

/**
 * Why setup doesn't point Claude Code at the router when it would carry another gateway's
 * credentials there, and what to remove first.
 * @param {Gateway} gateway
 */
function leakText({ bases, credentials }) {
  /** @type {Map<string, string[]>} */
  const byPlace = new Map();
  for (const { name, where } of [...bases.map((base) => ({ name: 'ANTHROPIC_BASE_URL', where: base.where })), ...credentials])
    byPlace.set(where, [...new Set([...(byPlace.get(where) ?? []), name])]);
  const removals = [...byPlace].map(([where, names]) =>
    where === 'this shell' ? `${inWords(names)} from your shell (its startup files, such as ~/.zshrc)` : `${inWords(names)} from ${where}`,
  );
  const targets = inWords(bases.map((base) => `${base.url} (ANTHROPIC_BASE_URL in ${base.where})`));
  const newShell = byPlace.has('this shell') ? ', open a new shell' : '';
  return (
    `Claude Code sends its requests to ${targets}, with ${credentialsInWords(credentials)}. ` +
    `Behind the router it would send those credentials to Anthropic, so setup doesn't point Claude Code at the router: ` +
    `remove ${inWords(removals)}${newShell}, then run setup again.`
  );
}

/**
 * @typedef {object} KeyContext
 * @property {Config} cfg
 * @property {NodeJS.ProcessEnv} env
 * @property {Record<string, string>} saved
 * @property {Prompter | undefined} prompter
 * @property {AbortSignal} signal
 */

/**
 * The keys to save: a Jev key that works, and the keys Claude Code's other tiers need.
 * @param {KeyContext} context
 * @returns {Promise<Record<string, string> | undefined>} the variables whose value changes; undefined when the Jev key failed under --yes
 */
async function collectKeys(context) {
  const { cfg, env, saved } = context;
  if (!cfg.jev.channels.length) throw new Error('the config has no Jev channels (jev.channels), so setup has no key to ask for');
  if (!cfg.jev.channels.some(hasKeyEnv))
    throw new Error('the config has no Jev channel with a key (jev.channels[].keyEnv), so setup has no key to ask for');
  const others = upstreamKeys(cfg, 'anthropic');
  if (!context.prompter) keysFromEnvironment(cfg, env, others);
  const jev = await workingJevKey(context);
  if (!jev) return undefined;
  /** @type {Record<string, string>} */
  const keys = { [jev.channel.keyEnv]: jev.value };
  for (const [name, tiers] of others) keys[name] = await upstreamKey(context, name, tiers);
  return Object.fromEntries(Object.entries(keys).filter(([name, value]) => saved[name] !== value));
}

/**
 * Stops `setup --yes` early when a key it needs isn't in the environment, or can't be a key.
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 * @param {Map<string, string[]>} others the keys of Claude Code's tiers besides Jev's
 */
function keysFromEnvironment(cfg, env, others) {
  const missing = [...others].filter(([name]) => !env[name]).map(([name, tiers]) => `${name} for Claude Code's ${inWords(tiers)} tier`);
  const keyed = cfg.jev.channels.filter(hasKeyEnv);
  const jev = keyed.find((ch) => env[ch.keyEnv]);
  if (!jev) missing.unshift(`${orWords(keyed.map((ch) => ch.keyEnv))} for Jev`);
  if (missing.length) throw new Error(`setup --yes takes the keys from the environment. Set ${inWords(missing)}.`);
  const odd = [...(jev ? [jev.keyEnv] : []), ...others.keys()].filter((name) => oddKey(env[name] ?? ''));
  if (odd.length)
    throw new Error(`${inWords(odd)} holds a space or a control character, which no key has. Check the variable, then run setup again.`);
}

/**
 * The key variables of a surface's targets that don't pass the client's login through, each with the tiers that use it.
 * @param {Config} cfg
 * @param {'anthropic' | 'openai'} surface
 * @returns {Map<string, string[]>}
 */
function upstreamKeys(cfg, surface) {
  /** @type {Map<string, string[]>} */
  const keys = new Map();
  for (const [tier, target] of Object.entries(cfg.surfaces[surface] ?? {})) {
    if (target.clientAuth || !target.keyEnv || tier === 'side') continue;
    keys.set(target.keyEnv, [...(keys.get(target.keyEnv) ?? []), tier]);
  }
  return keys;
}

/**
 * A key's value now, and where it comes from: the env file, or this shell.
 * @param {KeyContext} context
 * @param {string} name
 * @returns {{ value: string, where: string } | undefined}
 */
function currentKey({ env, saved }, name) {
  const value = env[name];
  if (!value) return undefined;
  return { value, where: saved[name] === value ? 'saved' : 'set in this shell' };
}

/**
 * Asks for a Jev key, or takes it from the environment, and checks it with one Jev call until one works.
 * @param {KeyContext} context
 * @returns {Promise<{ channel: JevChannel & { keyEnv: string }, value: string } | undefined>}
 */
async function workingJevKey(context) {
  const { cfg, prompter, signal } = context;
  const places = cfg.jev.channels
    .filter(hasKeyEnv)
    .map((ch) => `${keyName(ch.keyEnv)}${KEY_PLACES[ch.keyEnv] ? ` (${KEY_PLACES[ch.keyEnv]})` : ''}`);
  say(`Jev decides which model each message needs. It takes a key from ${orWords(places)}; one is enough.\n`);
  for (let retry = false; ; retry = true) {
    const jev = prompter ? await askJevKey(context, prompter, retry) : jevKeyFromEnv(context);
    if (prompter && oddKey(jev.value)) {
      prompter.say('That key has a space or a control character in it, which no key has. Paste it again.\n');
      continue;
    }
    say(`Checking the ${keyName(jev.channel.keyEnv)} key with one Jev call (about $0.00003)... `);
    const client = new JevClient(
      { ...cfg.jev, deadlineMs: 15000, channels: [{ ...jev.channel, timeoutMs: 10000 }] },
      { [jev.channel.keyEnv]: jev.value },
    );
    const answer = await client.decide(SAMPLE_STATE, { signal });
    if (signal.aborted) throw new PromptAbort('interrupted', 130);
    if (answer.ok) {
      say(`it works (${answer.channel} answered in ${answer.ms} ms).\n`);
      return jev;
    }
    say(`it didn't work: ${answer.error}\n`);
    const refused = keyRefused(answer.error);
    if (!prompter) {
      say(`Nothing was written. ${refused ? 'Check the key' : NO_ANSWER}, then run setup again.\n`);
      return undefined;
    }
    if (!refused) say(`${NO_ANSWER}.\n`);
    if (!(await prompter.confirm(refused ? 'Try another key?' : 'Try again?', true))) throw new PromptAbort('no Jev key worked', 1);
  }
}

/** What to check when Jev didn't answer at all: the key was never looked at. */
const NO_ANSWER =
  "Jev didn't answer, so the key wasn't checked. Check the connection (behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1)";

/**
 * Whether Jev turned the key down, rather than not answering: only then is the key the problem.
 * @param {string} error the failed call's error, such as `typesafe: HTTP 401 invalid API key`
 */
const keyRefused = (error) => /\bHTTP 40[123]\b/.test(error);

/**
 * @param {KeyContext} context
 * @returns {{ channel: JevChannel & { keyEnv: string }, value: string }}
 */
function jevKeyFromEnv({ cfg, env }) {
  const channel = /** @type {JevChannel & { keyEnv: string }} */ (cfg.jev.channels.filter(hasKeyEnv).find((ch) => env[ch.keyEnv]));
  return { channel, value: /** @type {string} */ (env[channel.keyEnv]) };
}

/**
 * Asks for a Jev key: Enter keeps one that is saved or set, else moves on to the next channel.
 * After a key failed, keeping it isn't offered.
 * @param {KeyContext} context
 * @param {Prompter} prompter
 * @param {boolean} retry
 * @returns {Promise<{ channel: JevChannel & { keyEnv: string }, value: string }>}
 */
async function askJevKey(context, prompter, retry) {
  const channels = context.cfg.jev.channels.filter(hasKeyEnv);
  const existing = retry ? undefined : channels.find((ch) => currentKey(context, ch.keyEnv));
  if (existing) {
    const current = /** @type {{ value: string, where: string }} */ (currentKey(context, existing.keyEnv));
    const value = await prompter.secret(`${keyName(existing.keyEnv)} API key [${current.where}; press Enter to keep it]: `);
    return { channel: existing, value: value || current.value };
  }
  for (let i = 0; ; i = (i + 1) % channels.length) {
    const next = channels[(i + 1) % channels.length];
    const instead =
      channels.length > 1
        ? ` (press Enter to use a${/^[AEIOU]/.test(keyName(next.keyEnv)) ? 'n' : ''} ${keyName(next.keyEnv)} key instead)`
        : '';
    const value = await prompter.secret(`${keyName(channels[i].keyEnv)} API key${instead}: `);
    if (value) return { channel: channels[i], value };
    if (channels.length === 1) prompter.say('Jev needs a key to pick the models.\n');
  }
}

/**
 * Asks for the key of one of Claude Code's tiers (Ollama's for the fast tier, say), or takes it from the environment.
 * @param {KeyContext} context
 * @param {string} name
 * @param {string[]} tiers
 * @returns {Promise<string>}
 */
async function upstreamKey(context, name, tiers) {
  const current = currentKey(context, name);
  const { prompter } = context;
  if (!prompter) return /** @type {string} */ (context.env[name]);
  const what = `${keyName(name)} API key${KEY_PLACES[name] ? ` (${KEY_PLACES[name]})` : ''} for Claude Code's ${inWords(tiers)} tier${tiers.length > 1 ? 's' : ''}`;
  for (;;) {
    const value = (await prompter.secret(current ? `${what} [${current.where}; press Enter to keep it]: ` : `${what}: `)) || current?.value;
    if (value && !oddKey(value)) return value;
    prompter.say(value ? 'That key has a space or a control character in it, which no key has.\n' : `That tier needs ${name}.\n`);
  }
}

/**
 * The service part of the plan: whether to have one, whether the port is free for it, which
 * jev-router it runs (installing one for good when this copy runs from npx), and whether Claude
 * Code's settings may point at it.
 * @param {Plan} plan
 * @param {ManagerChoice} choice
 * @param {SetupOptions} options
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter
 * @returns {Promise<ServicePlan>}
 */
async function planService(plan, choice, options, env, prompter) {
  const manager = /** @type {Manager} */ (choice.manager);
  const question = options.claudeSettings
    ? 'Start jev-router in the background when you log in, and send every Claude Code session through it?'
    : 'Start jev-router in the background when you log in?';
  if (prompter) say('\n');
  if (prompter && !(await prompter.confirm(question, true))) return { why: 'you chose to start it yourself' };
  const file = serviceFile(manager, choice.configHome);
  const busy = existsSync(file) ? undefined : await portProblem(plan.host, plan.port);
  if (busy) return { manager, why: '', file, busy: { problem: busy, version: (await probe(plan.url)).health?.version } };
  const runs = await chooseCommand(plan, env, prompter);
  if ('none' in runs) return { why: runs.none };
  const unchanged = `Claude Code's settings are unchanged (--no-claude-settings).${leaks(plan.gateway) ? ` ${leakText(plan.gateway)}` : ''}`;
  const settings = options.claudeSettings ? await planSettings(plan, prompter) : { skip: unchanged };
  return { manager, why: '', file, ...runs, settings };
}

/**
 * The jev-router the service runs: the global one, or one npm installs first when none is on PATH,
 * or when this copy runs from npx's cache (which npm can delete at any time) and the global one, if
 * any, is another version.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 * @param {Prompter | undefined} prompter
 * @returns {Promise<{ install: string } | { command: string } | { none: string }>}
 */
async function chooseCommand(plan, env, prompter) {
  const { installed } = plan;
  if (installed && (!plan.origin.npx || commandVersion(installed, env) === VERSION)) {
    if (!sameFile(installed, packaged('bin/jev-router.mjs')))
      say(`note: the service runs the jev-router on your PATH, ${installed}, not the copy that runs setup.\n`);
    return { command: installed };
  }
  say(
    plan.origin.npx
      ? 'The background service needs a copy of jev-router that stays put, and npm can delete its npx cache at any time.\n'
      : "The background service needs jev-router installed, and there's none on your PATH.\n",
  );
  const install = `npm install -g ${shellQuote(plan.origin.spec)}`;
  if (!prompter || (await prompter.confirm(`Install it now with: ${install}?`, true))) return { install: plan.origin.spec };
  if (installed) return { command: installed };
  return { none: `the service needs an installed jev-router, and you chose not to install one (${install})` };
}

/**
 * Whether setup may point Claude Code's settings at the router. Never when Claude Code goes to
 * another gateway with credentials for it; when it goes elsewhere without them, only on a yes, and
 * --yes keeps it.
 * @param {Plan} plan
 * @param {Prompter | undefined} prompter
 * @returns {Promise<{ replaceForeign: boolean } | { skip: string }>}
 */
async function planSettings(plan, prompter) {
  const { gateway } = plan;
  if (leaks(gateway)) return { skip: leakText(gateway) };
  if (!gateway.bases.length) return { replaceForeign: false };
  const [settings, shell] = [
    gateway.bases.find((base) => base.where !== 'this shell'),
    gateway.bases.find((base) => base.where === 'this shell'),
  ];
  say(
    settings
      ? `Claude Code's settings (${gateway.file}) send it to ${settings.url}${shell ? `, and this shell to ${shell.url}` : ''}.\n`
      : `This shell sends Claude Code to ${shell?.url} (ANTHROPIC_BASE_URL). The router's address in ${gateway.file} would override that in every session.\n`,
  );
  if (!prompter) say('--yes keeps that. To send Claude Code through the router instead, run setup without --yes and answer yes.\n');
  else if (await prompter.confirm('Replace that with the router?', false)) return { replaceForeign: true };
  return { skip: `Claude Code's settings are unchanged: it keeps sending its requests to ${(settings ?? shell)?.url}.` };
}

/**
 * Takes setup's own variables back out of Claude Code's settings when another gateway's credentials
 * would ride through the router to Anthropic: an earlier setup pointed Claude Code at the router,
 * and the settings file's address overrides the gateway the shell names. Only what setup recorded,
 * and still holds the value setup wrote, is taken back.
 * @param {Manifest} manifest changed in place: its record of the settings goes once they're taken back
 * @returns {string | undefined} what happened, or undefined when the settings don't point at the router setup's way
 */
function revertForLeak(manifest) {
  const record = manifest.claude;
  const own = record?.env.ANTHROPIC_BASE_URL?.value;
  if (!record || !own) return undefined;
  const read = readSettings(record.file);
  if ('problem' in read)
    return `Claude Code's settings (${record.file}) still send it to the router, and setup can't change them: ${read.problem}. Remove ANTHROPIC_BASE_URL from them yourself.`;
  if (settingsBlock(read.data).ANTHROPIC_BASE_URL !== own) return undefined;
  const changes = changeSettingsEnv(read.data, recordedValues(record, settingsBlock(read.data)));
  manifest.claude = undefined;
  const names = inWords(changes.map((change) => change.name));
  if (record.created && !Object.keys(read.data).length) {
    rmSync(record.file, { force: true });
    return `Claude Code's settings (${record.file}) sent it to the router, and so those credentials too: setup removed the file, which it had created. Restart any Claude Code session that's running.`;
  }
  writeSettings(record.file, read, `${record.file}.jev-router.bak`);
  return (
    `Claude Code's settings (${record.file}) sent it to the router, and so those credentials too: setup took ${names} back out. ` +
    `The old file is ${record.file}.jev-router.bak. Restart any Claude Code session that's running.`
  );
}

/**
 * Writes what the plan says, starts the service, and points Claude Code at it once it answers.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function carryOut(plan, env) {
  say('\n');
  writeFiles(plan);
  const { service } = plan;
  if (!service.manager) return finishWithoutService(plan, env);
  if (service.busy) return portBusy(plan, service.busy);
  if (!isLoopback(plan.host) && !plan.token) {
    say(
      `jev-router: the router won't listen on ${plan.host} without a token. Put JEV_ROUTER_TOKEN=<a secret> in ${plan.envFile}, then run setup again.\n`,
    );
    return 1;
  }
  const command = await serviceCommand(plan, env);
  if (!command) return 1;
  if (envValue(env, 'JEV_ROUTER_TOKEN') && env.JEV_ROUTER_TOKEN !== plan.token)
    say(`note: JEV_ROUTER_TOKEN is set in this shell, but the service can't see it. Put it in ${plan.envFile} to use it.\n`);
  const file = /** @type {string} */ (service.file);
  if (!(await runService(plan, service.manager, file, command.path, env))) return 1;
  /** @type {Manifest} */
  const manifest = {
    service: { manager: service.manager, file },
    files: { config: plan.configPath, env: plan.envFile, log: plan.logFile },
    claude: readManifest(env)?.claude,
  };
  let skip = service.settings && 'skip' in service.settings ? service.settings.skip : undefined;
  if (skip && leaks(plan.gateway)) skip = [skip, revertForLeak(manifest)].filter(Boolean).join('\n');
  const settings = skip ? { file: '', outcome: { text: skip, pointed: false }, write: () => undefined } : pointClaude(plan, manifest, env);
  writeManifest(env, manifest); // first: whatever happens to settings.json next, uninstall can undo it
  finishWithService(plan, command, writeClaude(plan, settings));
  return 0;
}

/**
 * Writes the keys and router settings that changed, then the config for a machine without one, or
 * the one it switches to. The keys go first: the new config may need one, and an extra key doesn't
 * disturb the old config.
 * @param {Plan} plan its `models` and `replaces` go when the config changed while setup ran
 */
function writeFiles(plan) {
  const names = Object.keys(plan.keys);
  const router = Object.entries(plan.routerVariables).map(([name, value]) => `${name}=${value}`);
  const loose = existsSync(plan.envFile) && looseFile(plan.envFile, statSync(plan.envFile).mode);
  if (names.length || router.length || loose) saveEnvValues(plan.envFile, { ...plan.keys, ...plan.routerVariables }); // mode 0600
  if (names.length) say(`Saved ${inWords(names)} in ${plan.envFile}, readable only by you.\n`);
  else say(`Kept the keys in ${plan.envFile}${loose ? ', and made it readable only by you' : ''}.\n`);
  if (router.length) say(`Saved ${inWords(router)} there too, so every jev-router command finds the router.\n`);
  if (!plan.models) {
    say(`Kept ${plan.configPath}.\n`);
    return;
  }
  // An edit saved while setup asked its questions wins over the switch.
  if (plan.replaces && packagedModels(plan.configPath) !== plan.replaces) {
    say(`Kept ${plan.configPath}: it changed while setup ran.\n`);
    plan.models = undefined;
    plan.replaces = undefined;
    return;
  }
  writeFileAtomic(plan.configPath, readFileSync(PACKAGED_CONFIGS[plan.models], 'utf8'), 0o600);
  say(
    plan.replaces
      ? `Switched ${plan.configPath} from ${MODELS[plan.replaces].short} to ${MODELS[plan.models].short}.\n`
      : `Wrote ${plan.configPath} (${MODELS[plan.models].what}).\n`,
  );
}

/**
 * Stops before the service, when something else holds the router's port.
 * @param {Plan} plan
 * @param {{ problem: string, version?: string }} busy
 */
function portBusy(plan, { problem, version }) {
  const what = version
    ? `A jev-router ${version} already answers at ${plan.url}, probably one you started yourself with jev-router serve or launch`
    : `Something else holds ${plan.url} (${problem})`;
  say(
    `\n${what}. The service would fail to start next to it.\n` +
      'Stop it, then run setup again. Your config and keys are saved, and Enter keeps them.\n' +
      `To use another port instead, run setup with JEV_ROUTER_PORT set, for example JEV_ROUTER_PORT=${plan.port + 1}.\n`,
  );
  return 1;
}

/**
 * The global jev-router the service runs, installing it first when the plan says so.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Command | undefined>} undefined when there is none, after saying why
 */
async function serviceCommand(plan, env) {
  const { install, command } = plan.service;
  if (command) return { path: command, onPath: true };
  say(`\nInstalling jev-router for good: npm install -g ${shellQuote(/** @type {string} */ (install))}\n`);
  const result = await npmInstall(/** @type {string} */ (install), env);
  const found = result.ok ? globalCommand(env) : undefined;
  if (found) {
    if (!found.onPath)
      say(`note: npm put jev-router in ${dirname(found.path)}, which isn't on your PATH. Add it to PATH to run jev-router yourself.\n`);
    return found;
  }
  say(
    `\n${result.ok ? "npm installed jev-router, but setup can't find it: check npm prefix -g" : `The install failed: ${result.why}`}. The service isn't installed, and Claude Code's settings are unchanged.\n`,
  );
  if (!result.ok && legacyInstall(env))
    say(
      `jev-router 1.4.0 and older were called ${LEGACY_PACKAGE}, and npm won't replace their command. Remove it first:\n  npm uninstall -g ${LEGACY_PACKAGE}\n`,
    );
  else
    say(
      'If npm may not write to its global directory, use Node from a version manager (nvm, fnm, or Homebrew on a Mac), ' +
        'or give npm a directory of your own with npm config set prefix ~/.local and put ~/.local/bin on PATH, ' +
        `or install it with sudo: sudo npm install -g ${shellQuote(/** @type {string} */ (install))}\n`,
    );
  say(`Your keys and config are saved: run setup again (${commandForm(plan)} setup) and it picks up from here.\n`);
  return undefined;
}

/**
 * How long to wait for the service's router: JEV_ROUTER_SETUP_WAIT seconds, or 15.
 * @param {NodeJS.ProcessEnv} env
 */
function waitSeconds(env) {
  const given = envValue(env, 'JEV_ROUTER_SETUP_WAIT');
  const seconds = Number(given);
  if (given === undefined || (Number.isFinite(seconds) && seconds > 0)) return given === undefined ? WAIT_SECONDS : seconds;
  say(`note: JEV_ROUTER_SETUP_WAIT takes a number of seconds above 0, not ${JSON.stringify(given)}, so setup waits ${WAIT_SECONDS} s.\n`);
  return WAIT_SECONDS;
}

/**
 * Writes the service file, (re)starts the service, and waits until its router answers.
 * @param {Plan} plan
 * @param {Manager} manager
 * @param {string} file
 * @param {string} command the global jev-router
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<boolean>}
 */
async function runService(plan, manager, file, command, env) {
  const path = [...new Set([dirname(command), dirname(process.execPath), '/usr/bin', '/bin'])].join(':');
  // The host and port are in the env file, which the service reads like every other command.
  const args = [
    '/usr/bin/env',
    'jev-router',
    'serve',
    '--ui',
    plan.ui,
    '--config',
    plan.configPath,
    '--env-file',
    plan.envFile,
    '--log-file',
    plan.logFile,
  ];
  if (manager === 'launchd') mkdirSync(dirname(launchdErrorLog()), { recursive: true, mode: 0o700 });
  const wait = waitSeconds(env);
  const since = Date.now();
  try {
    await startService(manager, file, renderService(manager, { args, path }), env);
  } catch (err) {
    say(`\njev-router: ${errorMessage(err)}\nClaude Code's settings are unchanged.\n`);
    return false;
  }
  say(`Started the ${MANAGER_NAMES[manager]} ${file}.\nWaiting for the router at ${plan.url}... `);
  if (await answers(plan.url, since, wait * 1000)) {
    say('it answers.\n');
    return true;
  }
  say(`it didn't answer within ${wait} s.\nSee what went wrong in: ${logHint(manager)}\nClaude Code's settings are unchanged.\n`);
  return false;
}

/**
 * Waits for a router that started after `since` to answer at `url`. One that has run longer, such
 * as a router started by hand, isn't the service's.
 * @param {string} url
 * @param {number} since
 * @param {number} ms
 */
async function answers(url, since, ms) {
  const deadline = Date.now() + ms;
  do {
    const { health } = await probe(url);
    if (health && health.uptime_s <= (Date.now() - since) / 1000 + 1) return true;
    await sleep(200);
  } while (Date.now() < deadline);
  return false;
}

/**
 * What pointing Claude Code's settings at the router would change: the variables `claudeVars`
 * gives, merged into the `env` block, recorded in the manifest, and a write to run once the
 * manifest is saved. Variables whose value isn't a string stay as they are.
 * @param {Plan} plan
 * @param {Manifest} manifest changed in place
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ file: string, outcome: SettingsOutcome, write: () => void }}
 */
function pointClaude(plan, manifest, env) {
  const file = claudeSettingsPath(env);
  const read = readSettings(file);
  if ('problem' in read) return { file, outcome: { text: byHand(plan, file, read.problem), pointed: false }, write: () => undefined };
  const before = settingsBlock(read.data);
  const changes = changeSettingsEnv(read.data, claudeVars(settingsSet(read.data), plan.url, plan.token));
  const earlier = manifest.claude?.file === file ? manifest.claude : undefined;
  const created = earlier?.created ?? (!read.exists && changes.length > 0);
  manifest.claude = { file, ...(created ? { created } : {}), ...recordChanges(earlier, changes, before) };
  if (!changes.length)
    return {
      file,
      outcome: { text: `Claude Code's settings (${file}) point at the router already.`, pointed: true },
      write: () => undefined,
    };
  const backup = read.exists ? ` The old file is ${file}.jev-router.bak.` : '';
  const text = `Claude Code's settings (${file}) now send it through the router: set ${inWords(changes.map((change) => change.name))}.${backup}`;
  return { file, outcome: { text, pointed: true, changed: true }, write: () => writeSettings(file, read, `${file}.jev-router.bak`) };
}

/**
 * Runs the settings write, and says what to add by hand when it fails.
 * @param {Plan} plan
 * @param {{ file: string, outcome: SettingsOutcome, write: () => void }} settings
 * @returns {SettingsOutcome}
 */
function writeClaude(plan, { file, outcome, write }) {
  try {
    write();
    return outcome;
  } catch (err) {
    const problem = errorCode(err) === 'EACCES' || errorCode(err) === 'EPERM' ? 'permission denied' : errorMessage(err);
    return { text: byHand(plan, file, `setup can't write it (${problem})`), pointed: false };
  }
}

/**
 * What to add to Claude Code's settings by hand, with a placeholder for the router token.
 * @param {Plan} plan
 * @param {string} file
 * @param {string} problem
 */
function byHand(plan, file, problem) {
  const vars = claudeVars({}, plan.url, plan.token && '<your JEV_ROUTER_TOKEN>');
  return `Setup didn't change ${file}: ${problem}. Add this to its "env" block yourself:\n${JSON.stringify(vars, null, 2)}`;
}

/**
 * The manifest's record of Claude Code's settings after a run: earlier records whose variable held
 * what setup wrote until this run, and this run's changes. A variable setup changes again keeps the
 * value it had before setup first changed it. The router token isn't recorded, only whether setup
 * added its header line.
 * @param {Manifest['claude']} earlier
 * @param {SettingsChange[]} changes
 * @param {Record<string, string>} before the settings before this run
 * @returns {{ env: Record<string, { value: string, previous?: string }>, tokenHeader?: 'created' | 'added' }}
 */
function recordChanges(earlier, changes, before) {
  /** @type {Record<string, { value: string, previous?: string }>} */
  const records = Object.fromEntries(Object.entries(earlier?.env ?? {}).filter(([name, record]) => before[name] === record.value));
  let tokenHeader = earlier?.tokenHeader && hasTokenLine(before.ANTHROPIC_CUSTOM_HEADERS) ? earlier.tokenHeader : undefined;
  for (const { name, before: was, after } of changes) {
    if (after === undefined) continue;
    if (name === 'ANTHROPIC_CUSTOM_HEADERS') tokenHeader = tokenHeader === 'created' || was === undefined ? 'created' : 'added';
    else
      records[name] = records[name]
        ? { ...records[name], value: after }
        : { value: after, ...(was === undefined ? {} : { previous: was }) };
  }
  return tokenHeader ? { env: records, tokenHeader } : { env: records };
}

/**
 * The command that works for this person: `jev-router` when it's installed on PATH, its path when
 * it's installed elsewhere, npx when this copy runs from npx, else this copy's own path.
 * @param {Plan} plan
 * @param {Command} [global] the global jev-router the service runs
 */
function commandForm(plan, global) {
  if (global) return global.onPath ? 'jev-router' : shellQuote(global.path);
  if (plan.installed) return 'jev-router';
  return plan.origin.npxCommand ?? shellQuote(packaged('bin/jev-router.mjs'));
}

/**
 * The summary for a machine without the service: setup is done, and launch is how to start, unless
 * Claude Code carries another gateway's credentials that launch would pass on to Anthropic.
 * @param {Plan} plan
 * @param {NodeJS.ProcessEnv} env
 */
function finishWithoutService(plan, env) {
  const run = commandForm(plan);
  const leftover = installedServices(env, readManifest(env)?.service)[0];
  say(`\nDone. There's no background service: ${plan.service.why}.\n`);
  if (leaks(plan.gateway)) say(`${leakText(plan.gateway)}\n`);
  else
    say(
      `Start Claude Code through the router with: ${run} launch claude\n` +
        `Watch it live at http://127.0.0.1:${UI_PORT} with: ${run} launch claude --ui ${UI_PORT}\n`,
    );
  say(`Check it: ${run} doctor\n`);
  if (plan.replaces) say(`A router that's already running keeps using ${MODELS[plan.replaces].short} until it restarts.\n`);
  if (leftover)
    say(
      `The ${MANAGER_NAMES[leftover.manager]} from an earlier setup is still installed (${leftover.file}); ${run} uninstall removes it.\n`,
    );
  codexHint(plan, run, false);
  return 0;
}

/**
 * The summary once the service runs.
 * @param {Plan} plan
 * @param {Command} command the global jev-router the service runs
 * @param {SettingsOutcome} settings what happened to Claude Code's settings
 */
function finishWithService(plan, command, { text, pointed, changed }) {
  const run = commandForm(plan, command);
  const ui = /** @type {{ host: string, port: number }} */ (parseUiAddress(plan.ui));
  say(`${text}\n`);
  if (changed) say("Restart any Claude Code session that's already running, so it picks up the settings.\n");
  const start = pointed
    ? 'Start Claude Code as usual: claude\n'
    : leaks(plan.gateway)
      ? "Claude Code doesn't go through the router until you remove what's named above.\n"
      : `Start Claude Code through the router with: ${run} launch claude\n`;
  say(
    '\nDone. jev-router runs in the background and starts when you log in.\n' +
      `  Router     ${plan.url}\n` +
      `  Live view  http://${clientHost(ui.host)}:${ui.port}\n` +
      `  Keys       ${plan.envFile}\n` +
      `  Log        ${plan.logFile}\n\n` +
      start +
      `Check it: ${run} doctor\n` +
      `Undo it: ${run} uninstall\n`,
  );
  if (plan.service.manager === 'systemd') say('To keep it running while you are logged out, run: loginctl enable-linger\n');
  codexHint(plan, run, true);
}

/**
 * Where Codex's keys go: setup asks only for Claude Code's.
 * @param {Plan} plan
 * @param {string} run
 * @param {boolean} service
 */
function codexHint(plan, run, service) {
  const saved = { ...plan.saved, ...plan.keys };
  const missing = [...upstreamKeys(plan.cfg, 'openai').keys()].filter((name) => !saved[name]);
  if (!missing.length) {
    say(`Codex: ${run} launch codex\n`);
    return;
  }
  const restart = service ? `, run ${run} setup again to restart the router with ${missing.length > 1 ? 'them' : 'it'}` : '';
  say(`Codex: put ${inWords(missing)} in ${plan.envFile}${restart}, then run: ${run} launch codex\n`);
}

/**
 * The manifest setup wrote, if any.
 * @param {NodeJS.ProcessEnv} env
 * @returns {Manifest | undefined}
 */
export function readManifest(env) {
  try {
    const manifest = JSON.parse(readFileSync(setupManifestPath(env), 'utf8'));
    return typeof manifest === 'object' && manifest !== null ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Manifest} manifest
 */
export function writeManifest(env, manifest) {
  const note = 'Written by jev-router setup: what it changed, for jev-router uninstall. It holds no keys.';
  writeFileAtomic(setupManifestPath(env), `${JSON.stringify({ note, ...manifest }, null, 2)}\n`, 0o600);
}
