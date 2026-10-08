// Loads the router config and checks it before the first request, so a typo stops the router at
// startup instead of quietly turning off a guard or rerouting traffic. Every problem is reported at once.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/** @import { Config, Env, JevChannel, JevConfig, Policy, Target } from './types.js' */

/**
 * A config file as parsed: the shape of a Config, with anything possibly missing or wrong.
 * @typedef {Partial<Omit<Config, 'policy' | 'jev' | 'surfaces'>> & {
 *   policy?: Partial<Policy>,
 *   jev?: Partial<Omit<JevConfig, 'channels'>> & { channels?: Array<Partial<JevChannel>> },
 *   surfaces?: Record<string, Record<string, Partial<Target>>>,
 * }} RawConfig
 */

/**
 * Records `message` as a problem unless `ok` is truthy.
 * @callback Need
 * @param {unknown} ok
 * @param {string} message
 * @returns {void}
 */

// The file isn't validated yet, so these sets are asked about values of any type.
/** @type {ReadonlySet<unknown>} */
const AUTH = new Set(['x-api-key', 'bearer']);
/** @type {ReadonlySet<unknown>} */
const MODES = new Set(['ratchet', 'sticky']);

/**
 * Reads a JSON config file and validates it.
 * @param {string | URL} path
 * @param {Env} [env] the environment the defaults come from
 * @returns {Config}
 */
export function loadConfig(path, env = process.env) {
  /** @type {unknown} */
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config ${path}: ${/** @type {Error} */ (err).message}`);
  }
  return validateConfig(cfg, env);
}

/**
 * Returns the config with defaults filled in, or throws with the full list of problems.
 * @param {unknown} input a parsed config file; it is cloned, never changed
 * @param {Env} [env] the environment the defaults come from: XDG_STATE_HOME places the state file
 * @returns {Config}
 */
export function validateConfig(input, env = process.env) {
  const cfg = /** @type {RawConfig} */ (structuredClone(input));
  /** @type {string[]} */
  const problems = [];
  /** @type {Need} */
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };

  cfg.host ??= '127.0.0.1';
  cfg.port ??= 4000;
  cfg.allowedHosts ??= [];
  cfg.maxBodyBytes ??= 32 * 1024 * 1024;
  cfg.maxSessions ??= 10000;
  cfg.logMaxBytes ??= 50 * 1024 * 1024;
  cfg.sideCallModel ??= 'haiku';
  cfg.pinOnModelChange ??= true;
  if (cfg.stateFile === undefined) cfg.stateFile = `${env.XDG_STATE_HOME || `${homedir()}/.local/state`}/jev-router/sessions.jsonl`;
  if (typeof cfg.stateFile === 'string') cfg.stateFile = cfg.stateFile.replace(/^~(?=\/)/, homedir());
  if (typeof cfg.logFile === 'string') cfg.logFile = cfg.logFile.replace(/^~(?=\/)/, homedir());
  need(Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536, 'port must be an integer between 1 and 65535');
  need(typeof cfg.host === 'string' && cfg.host !== '', 'host must be an address or a host name');
  need(
    Array.isArray(cfg.allowedHosts) && cfg.allowedHosts.every((h) => typeof h === 'string'),
    'allowedHosts must be an array of host[:port] strings',
  );
  need(
    cfg.allowedOrigins === undefined || (Array.isArray(cfg.allowedOrigins) && cfg.allowedOrigins.every((o) => typeof o === 'string')),
    'allowedOrigins must be an array of origins',
  );
  // A string would never be over the limit, and a limit of 0 or less refuses every request.
  need(isCount(cfg.maxBodyBytes, 1), 'maxBodyBytes must be a whole number of bytes above 0');
  need(cfg.stateFile === null || (typeof cfg.stateFile === 'string' && cfg.stateFile !== ''), 'stateFile must be a file path or null');
  need(isRegExp(cfg.sideCallModel), 'sideCallModel must be a regular expression, such as "haiku"');
  need(typeof cfg.pinOnModelChange === 'boolean', 'pinOnModelChange must be true or false');
  // The session store evicts while it holds more than maxSessions, so a negative limit loops forever.
  need(Number.isInteger(cfg.maxSessions) && cfg.maxSessions > 0, 'maxSessions must be a positive integer');
  // A number would be taken for a file descriptor.
  need(cfg.logFile == null || (typeof cfg.logFile === 'string' && cfg.logFile !== ''), 'logFile must be a file path or null');
  need(Number.isInteger(cfg.logMaxBytes) && cfg.logMaxBytes >= 0, 'logMaxBytes must be a whole number of bytes, or 0 to never rotate');

  need(
    Array.isArray(cfg.tiers) && cfg.tiers.length > 0 && cfg.tiers.every((t) => typeof t === 'string'),
    'tiers must list tier names, cheapest first',
  );
  const tiers = new Set(cfg.tiers ?? []);
  need(cfg.defaultTier !== undefined && tiers.has(cfg.defaultTier), `defaultTier "${cfg.defaultTier}" is not one of tiers`);

  cfg.policy = checkPolicy(cfg.policy, tiers, need);
  cfg.jev = checkJev(cfg.jev, tiers, need);
  checkSurfaces(cfg.surfaces, tiers, need);
  cfg.modelPins ??= {};
  for (const [family, tier] of Object.entries(cfg.modelPins)) need(tiers.has(tier), `modelPins.${family} must be one of tiers`);
  cfg.prices ??= {};

  if (problems.length) throw new Error(`Invalid router config:\n  - ${problems.join('\n  - ')}`);
  return /** @type {Config} */ (cfg);
}

/**
 * The policy with defaults filled in. `accept` defaults to 0.6 for every tier.
 * @param {Partial<Policy> | undefined} input
 * @param {Set<string>} tiers
 * @param {Need} need
 * @returns {Partial<Policy>}
 */
function checkPolicy(input, tiers, need) {
  /** @type {Partial<Policy>} */
  const policy = {
    mode: 'ratchet',
    sensitiveOverride: 0.7,
    claimGuard: 0.5,
    maxProvisional: 3,
    idleResetMinutes: 10,
    failClosed: false,
    ...input,
  };
  need(MODES.has(policy.mode), 'policy.mode must be "ratchet" or "sticky"');
  need(isCount(policy.maxProvisional, 0), 'policy.maxProvisional must be a whole number, 0 or more');
  need(
    typeof policy.idleResetMinutes === 'number' && policy.idleResetMinutes >= 0,
    'policy.idleResetMinutes must be a number of minutes, 0 or more',
  );
  // The string "false" would turn it on.
  need(typeof policy.failClosed === 'boolean', 'policy.failClosed must be true or false');
  policy.accept = { ...Object.fromEntries([...tiers].map((t) => [t, 0.6])), ...policy.accept };
  for (const [tier, p] of Object.entries(policy.accept)) {
    need(tiers.has(tier), `policy.accept names unknown tier "${tier}"`);
    need(isProbability(p), `policy.accept.${tier} must be a probability`);
  }
  need(
    policy.escalationCeiling === undefined || tiers.has(policy.escalationCeiling),
    `policy.escalationCeiling "${policy.escalationCeiling}" is not one of tiers`,
  );
  need(isProbability(policy.sensitiveOverride), 'policy.sensitiveOverride must be a probability');
  need(isProbability(policy.claimGuard), 'policy.claimGuard must be a probability');
  return policy;
}

/**
 * The Jev settings with defaults filled in, channel timeouts included.
 * @param {RawConfig['jev']} input
 * @param {Set<string>} tiers
 * @param {Need} need
 */
function checkJev(input, tiers, need) {
  const jev = { deadlineMs: 2500, requestChars: 4000, stripCode: true, guards: true, channels: [], ...input };
  need(isCount(jev.deadlineMs, 1), 'jev.deadlineMs must be a whole number of milliseconds above 0');
  need(isCount(jev.requestChars, 1), 'jev.requestChars must be a whole number above 0');
  need(typeof jev.stripCode === 'boolean', 'jev.stripCode must be true or false');
  need(typeof jev.guards === 'boolean', 'jev.guards must be true or false');
  need(Array.isArray(jev.channels), 'jev.channels must be an array');
  for (const [i, ch] of (Array.isArray(jev.channels) ? jev.channels : []).entries()) {
    if (!ch || typeof ch !== 'object') {
      need(false, `jev.channels[${i}] must be an object`);
      continue;
    }
    ch.timeoutMs ??= 1200;
    need(typeof ch.name === 'string' && ch.name, `jev.channels[${i}].name is required`);
    need(isUrl(ch.baseUrl), `jev.channels[${i}].baseUrl must be an http(s) URL`);
    need(typeof ch.model === 'string' && ch.model, `jev.channels[${i}].model is required`);
    need(typeof ch.keyEnv === 'string' && ch.keyEnv, `jev.channels[${i}].keyEnv is required`);
    // Anything else fails every Jev call, before it is made.
    need(isCount(ch.timeoutMs, 1), `jev.channels[${i}].timeoutMs must be a whole number of milliseconds above 0`);
  }
  need(typeof jev.question === 'string' && jev.question.length > 0, 'jev.question is required');
  need(jev.options && typeof jev.options === 'object' && Object.keys(jev.options).length >= 2, 'jev.options needs at least two options');
  for (const [name, option] of Object.entries(jev.options ?? {})) {
    need(tiers.has(option?.tier), `jev.options.${name}.tier must be one of tiers`);
  }
  return jev;
}

/**
 * Every surface needs a target per tier, and a trusted target when some tier's target isn't trusted.
 * @param {RawConfig['surfaces']} surfaces
 * @param {Set<string>} tiers
 * @param {Need} need
 */
function checkSurfaces(surfaces, tiers, need) {
  need(surfaces && typeof surfaces === 'object', 'surfaces is required');
  for (const [surface, targets] of Object.entries(surfaces ?? {})) {
    for (const tier of tiers) need(targets[tier], `surfaces.${surface} has no target for tier "${tier}"`);
    const untrusted = [...tiers].some((t) => targets[t] && !targets[t].trusted);
    need(
      !untrusted || targets.trusted?.trusted,
      `surfaces.${surface} routes some tiers to untrusted upstreams, so it needs a trusted target marked "trusted": true`,
    );
    for (const [name, target] of Object.entries(targets)) checkTarget(target, `surfaces.${surface}.${name}`, need);
  }
}

/**
 * @param {Partial<Target>} target
 * @param {string} where the target's path in the config, for messages
 * @param {Need} need
 */
function checkTarget(target, where, need) {
  need(isUrl(target.url), `${where}.url must be an http(s) URL`);
  need(typeof target.model === 'string' && target.model, `${where}.model is required`);
  need(AUTH.has(target.auth), `${where}.auth must be "x-api-key" or "bearer"`);
  need(target.keyEnv || target.clientAuth, `${where} needs keyEnv or clientAuth`);
  need(!target.clientAuth || target.trusted === true, `${where}.clientAuth needs trusted`);
  need(
    target.stripPath === undefined || (typeof target.stripPath === 'string' && /^\/(?!\.+$)[\w.~-]+$/.test(target.stripPath)),
    `${where}.stripPath must be a path prefix such as "/v1"`,
  );
  need(
    target.omit === undefined || (Array.isArray(target.omit) && target.omit.every((f) => typeof f === 'string')),
    `${where}.omit must be a list of field paths`,
  );
  need(
    target.maxOutputTokens === undefined || (Number.isInteger(target.maxOutputTokens) && Number(target.maxOutputTokens) > 0),
    `${where}.maxOutputTokens must be a positive whole number`,
  );
  need(
    target.foldSystemMessages === undefined || typeof target.foldSystemMessages === 'boolean',
    `${where}.foldSystemMessages must be true or false`,
  );
  need(
    target.omitBetas === undefined || (Array.isArray(target.omitBetas) && target.omitBetas.every((b) => typeof b === 'string')),
    `${where}.omitBetas must be a list of beta names`,
  );
}

/**
 * @param {unknown} value
 * @param {number} min
 */
function isCount(value, min) {
  return Number.isInteger(value) && Number(value) >= min;
}

/**
 * Whether a value compiles as a regular expression: sideCallModel is one, applied to every request without hint headers.
 * @param {unknown} value
 */
function isRegExp(value) {
  if (typeof value !== 'string') return false;
  try {
    new RegExp(value, 'i');
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function isProbability(value) {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** @param {unknown} value */
function isUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(String(value)).protocol);
  } catch {
    return false;
  }
}
