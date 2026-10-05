// Shared types for the JSDoc annotations in src/, test/ and eval/. Import them where needed:
//   /** @import { Config, Target } from './types.js' */
// Object shapes that end up in a log line are type aliases, not interfaces, so that a log callback
// typed `(entry: Record<string, unknown>) => void` accepts them.

import type { IncomingHttpHeaders, Server } from 'node:http';
import type { SessionStore } from './sessions.mjs';

export type { IncomingHttpHeaders };

/** Environment variables, as in `process.env`. */
export type Env = Record<string, string | undefined>;

/** The subset of `fetch` the router uses, so tests can pass a plain function. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------------------------
// Config

/** The API a client speaks: Anthropic Messages (Claude Code) or OpenAI Responses (Codex CLI). */
export type Surface = 'anthropic' | 'openai';

/** An upstream that serves one tier of one surface. */
export interface Target {
  /** Base URL. The client's request path, query included, is appended unchanged, less `stripPath`. */
  url: string;
  /**
   * A prefix removed from the client's path before it is appended to `url`. `"/v1"` for ChatGPT's Codex backend,
   * which serves `/responses` under `https://chatgpt.com/backend-api/codex`.
   */
  stripPath?: string;
  /** Replaces the client's `model`. */
  model: string;
  /** How the router's key is sent: an `x-api-key` header or `authorization: Bearer`. */
  auth: 'x-api-key' | 'bearer';
  /** The environment variable that holds the router's key for this upstream. */
  keyEnv?: string;
  /** With no router key, forward the client's own credentials. Only for the client's own provider. */
  clientAuth?: boolean;
  /** Trusted with secrets and client identifiers. Other targets get redacted bodies and minimal headers. */
  trusted?: boolean;
  /** `false` when the upstream has no count_tokens endpoint. */
  countTokens?: boolean;
  /** Fields the upstream rejects, as dotted paths such as `output_config.effort`. */
  omit?: string[];
  /**
   * The most output tokens the model accepts; a larger `max_tokens` or `max_output_tokens` is lowered to it.
   * Defaults to the measured limit of known Claude models (64000 for Haiku 4.5, 128000 for the Claude 5 family).
   */
  maxOutputTokens?: number;
  /**
   * Fold `role: "system"` messages inside `messages` into the user message each follows. Defaults to true for
   * every model but the Claude 5 family, which takes them as they are; Haiku 4.5 rejects them.
   */
  foldSystemMessages?: boolean;
  /**
   * Beta flags to drop from `anthropic-beta`, because the model rejects them. Defaults to the 1M-context beta for
   * Haiku 4.5, which Claude Code asks for once its own model has a 1M window.
   */
  omitBetas?: string[];
}

/** One target per tier, plus `side` for background calls and `trusted` for sessions that carry secrets. */
export type SurfaceTargets = Record<string, Target>;

/** USD per million tokens. Cache prices default to the input price. */
export interface Price {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** How Jev's probabilities become a tier. */
export interface Policy {
  /** `ratchet`: a session's tier only goes up. `sticky`: the first decision holds for the session. */
  mode: 'ratchet' | 'sticky';
  /** The probability a tier needs before Jev's top pick is taken as is. */
  accept: Record<string, number>;
  /**
   * The most capable tier that Jev's unsure path reaches: when the top pick misses its bar, the
   * more capable of the top two, but no higher than this. Unset, it's the top tier.
   */
  escalationCeiling?: string;
  /** From this probability of altering sensitive state, a request gets the top tier. */
  sensitiveOverride: number;
  /** From this probability of a routing claim, a request can't go below the reference tier. */
  claimGuard: number;
  /** Jev failures in a row before a session stops being provisional. */
  maxProvisional: number;
  /** Idle minutes after which a session is decided afresh. */
  idleResetMinutes: number;
  /** Keep provisional sessions on trusted upstreams while Jev is failing. */
  failClosed: boolean;
}

/** A System One endpoint: TypeSafe, OpenRouter or a compatible server. */
export interface JevChannel {
  name: string;
  baseUrl: string;
  model: string;
  /** The environment variable with this channel's key. The key is only ever sent to `baseUrl`. */
  keyEnv: string;
  timeoutMs: number;
}

/** One answer Jev may pick. Every field except `tier` is sent to Jev as a criterion. */
export interface JevOption {
  tier: string;
  what?: string;
  examples?: string[];
  not_for?: string;
  [criterion: string]: unknown;
}

export interface JevConfig {
  /** Budget for the whole decision, across channels and retries. */
  deadlineMs: number;
  /** Longest request text Jev sees; longer ones keep their start and end. */
  requestChars: number;
  /** Replace code blocks with a one-line description before Jev sees them (the default). */
  stripCode: boolean;
  /** Ask the two guard questions (sensitive state, routing claims) along with the tier. */
  guards: boolean;
  channels: JevChannel[];
  question: string;
  options: Record<string, JevOption>;
}

/** A packaged config, as `setup --models` and `init --models` name it: Claude only, Claude with Fable 5.1, or Ollama Cloud and Claude. */
export type Models = 'claude' | 'fable' | 'ollama';

/** A validated config with every default filled in, as `validateConfig` returns it. */
export interface Config {
  host: string;
  port: number;
  /** Required in `x-jev-router-token` when set. `JEV_ROUTER_TOKEN` takes precedence. */
  token?: string;
  /** Host headers accepted besides the loopback names on the listening port. */
  allowedHosts: string[];
  allowedOrigins?: string[];
  maxBodyBytes: number;
  maxSessions: number;
  /** Where session state survives restarts; `null` keeps it in memory. */
  stateFile: string | null;
  /** A file every log line is appended to as well, besides stdout under `serve`. */
  logFile?: string | null;
  /** A log file that would grow past this many bytes is renamed to `<file>.1` first; 0 never rotates. Defaults to 50 MiB. */
  logMaxBytes: number;
  /** Tier names, cheapest first. */
  tiers: string[];
  defaultTier: string;
  /** A case-insensitive regular expression for the model names of background calls. */
  sideCallModel: string;
  /** Follow the user's /model switch to another model family. */
  pinOnModelChange: boolean;
  /** Model family (fable, opus, sonnet, haiku) to tier. */
  modelPins: Record<string, string>;
  policy: Policy;
  jev: JevConfig;
  surfaces: Partial<Record<Surface, SurfaceTargets>>;
  prices: Record<string, Price>;
  /** The model each surface's savings are measured against. */
  baselineModel?: Partial<Record<Surface, string>>;
}

// ---------------------------------------------------------------------------------------------
// Requests

/** A content block of a message, or a content part of an input item. Only the read fields are listed. */
export interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  signature?: string;
  [field: string]: unknown;
}

/** An Anthropic message or an OpenAI Responses input item. */
export interface Item {
  role?: string;
  type?: string;
  name?: string;
  content?: string | ContentBlock[];
  [field: string]: unknown;
}

/** An Anthropic Messages or OpenAI Responses request body. The router reads these fields and forwards the rest. */
export interface RequestBody {
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  system?: unknown;
  instructions?: string;
  messages?: Item[];
  input?: string | Item[];
  metadata?: { user_id?: string; [field: string]: unknown };
  prompt_cache_key?: string;
  [field: string]: unknown;
}

/** A message a human wrote. `index` points into the body's messages or input items. */
export interface Turn {
  index: number;
  text: string;
  images: number;
}

/** A conversation id and where it came from. */
export interface SessionKey {
  id: string;
  source: string;
}

// ---------------------------------------------------------------------------------------------
// Jev

/** The state Jev decides on. Key order is the order Jev reads it in. */
export interface JevState {
  request: string;
  recent_user_turns?: string[];
  last_assistant_message?: string;
  session: { harness: string; depth: string; recent_tools?: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, Omit<JevOption, 'tier'>>;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

/** The questions sent with every state: the tier, and the two guards when enabled. */
export interface JevQuestions {
  tier: ChoiceQuestion;
  alters_sensitive_state?: NoulQuestion;
  routing_claim_present?: NoulQuestion;
}

/** A System One response body, as far as the router reads it. */
export interface SystemOneResponse {
  id?: string;
  model?: string;
  answers?: {
    tier?: { choice?: string; probabilities?: Record<string, number> };
    alters_sensitive_state?: { noul?: number };
    routing_claim_present?: { noul?: number };
  };
  usage?: { input_tokens?: number };
}

/** What `applyPolicy` needs from an answer. */
export interface PolicyInput {
  /** Probability per option name. */
  probabilities: Record<string, number>;
  /** Probability that the request alters sensitive state. */
  sensitive?: number;
  /** Probability that the state carries a claim about the routing. */
  claim?: number;
}

export interface JevSuccess extends PolicyInput {
  ok: true;
  channel: string;
  model?: string;
  requestId?: string;
  ms: number;
  inputTokens?: number;
  choice?: string;
  /** The state was hardened after a firewall block. */
  hardened: boolean;
}

export interface JevFailure {
  ok: false;
  error: string;
  ms: number;
  /** The client went away during the call. */
  aborted?: boolean;
}

/** The result of `JevClient.decide`. */
export type JevAnswer = JevSuccess | JevFailure;

/** Per-channel counters behind /healthz and the circuit breaker. */
export interface ChannelStats {
  calls: number;
  errors: number;
  lastError: string | null;
  /** The breaker is open until this time (ms since the epoch). */
  openUntil: number;
}

/** A tier and the rule that picked it. */
export interface PolicyDecision {
  tier: string;
  reason: string;
  byTier: Record<string, number>;
}

// ---------------------------------------------------------------------------------------------
// Sessions and decisions

/** Routing state of one conversation. Holds tiers and hosts, never prompt text. */
export interface SessionEntry {
  tier: string;
  /** Secrets were seen, so only trusted upstreams serve this session. */
  trustedOnly: boolean;
  /** Decided without Jev; the next human turn asks again. */
  provisional: boolean;
  /** Jev failures while provisional. */
  attempts: number;
  /** The history shrank (compaction or a fork), so the next human turn is decided afresh. */
  freshNext: boolean;
  pinned?: boolean;
  /** The model the client asked for, to notice a /model switch. */
  clientModel?: string;
  /** Human turns seen so far. */
  turns?: number;
  /** The upstream host that served the last main request. */
  lastHost?: string;
  /** Hash of the human turn where the current provider took over. */
  anchor?: string;
  updated?: number;
  lastSeen?: number;
}

/** What the route log records about a Jev call. */
export type JevInfo =
  | { ok: false; ms: number; error: string }
  | {
      ok: true;
      channel: string;
      model?: string;
      requestId?: string;
      ms: number;
      inputTokens?: number;
      choice?: string;
      probabilities: Record<string, number>;
      tiers: Record<string, number>;
      sensitive?: number;
      claim?: number;
      hardened?: true;
    };

/** The tier for one request, why, and what to remember about the session. */
export interface Decision {
  key: SessionKey;
  /** main, subagent, compaction, auxiliary or workflow; undefined without hint headers. */
  kind?: string;
  turnCount: number;
  latestIndex?: number;
  latestText?: string;
  tier: string;
  reason: string;
  trustedOnly: boolean;
  /** The session entry to store, when the decision changes it. */
  remember?: SessionEntry;
  jev?: JevInfo;
  /** Secrets found in the latest human turn. */
  secrets?: number;
}

// ---------------------------------------------------------------------------------------------
// Usage and logs

/** Token usage of one response. `input` counts uncached input tokens only. */
export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Usage fields as Anthropic and OpenAI report them. */
export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
}

export type RouteLog = {
  ts: string;
  event: 'route';
  /** Numbers the request within this router run; its `done` entry carries the same number. */
  req: number;
  session: string;
  path: string;
  kind?: string;
  key_source: string;
  tier: string;
  reason: string;
  model: string;
  upstream: string;
  trusted_only?: true;
  secrets?: number;
  jev?: JevInfo;
};

export type DoneLog = {
  ts: string;
  event: 'done';
  req?: number;
  session: string;
  status: number;
  model?: string;
  ms: number;
  bytes?: number;
  sha256?: string;
  redacted?: number;
  client_aborted?: true;
  usage?: Usage;
  cost_usd?: number;
  baseline_usd?: number;
  /** The output limit `max_tokens` was lowered to, when it was. */
  capped_max_tokens?: number;
  /** How many mid-conversation system messages were folded into user messages. */
  folded_system?: number;
  /** The upstream's error message, for a status of 400 or more; or why its stream broke off, which an `error` entry also says. */
  error?: string;
};

export type WarningLog = { ts: string; event: 'warning'; message: string };

export type ErrorLog = { ts: string; event: 'error'; req?: number; session?: string; path?: string; error: string };

/** Jev is being asked about a session's new human turn; its `route` entry follows. */
export type DecidingLog = { ts: string; event: 'deciding'; session: string; turn: number };

/** Where a config routes: model names and upstream hosts, never keys or the names of their variables. */
export type ConfigSummary = {
  version: string;
  mode: 'ratchet' | 'sticky';
  tiers: string[];
  defaultTier: string;
  /** Each Jev option's tier. */
  options: Record<string, string>;
  accept: Record<string, number>;
  /** Set when the config caps Jev's unsure path below the top tier. */
  escalationCeiling?: string;
  sensitiveOverride: number;
  claimGuard: number;
  /** Per surface, each tier's target plus `side` and `trusted`. */
  surfaces: Record<string, Record<string, { model: string; upstream: string; trusted: boolean }>>;
  jev: { channels: Array<{ name: string; model: string; host: string }> };
};

/** Logged when the router starts and after every config reload. */
export type ConfigLog = { ts: string; event: 'config' } & ConfigSummary;

/** One line of the router's JSONL log. */
export type LogEntry = RouteLog | DoneLog | WarningLog | ErrorLog | DecidingLog | ConfigLog;

/** A log line as `jev-router ui` streams it: a log entry, or the router's plain-text output. */
export type UiEvent = LogEntry | { ts: string; event: 'text'; text: string } | ({ ts?: string; event: string } & Record<string, unknown>);

/** Options of `createUiServer`. */
export interface UiOptions {
  /** A router log to follow; it may not exist yet. Without one, entries come from `publish` only. */
  file?: string;
  /** How often to look for new lines. Defaults to 250 ms. */
  pollMs?: number;
  /** How much of the existing log to replay to a new page. Defaults to 512 KiB. */
  backlogBytes?: number;
  /** How many recent events a new page gets. Defaults to 2000. */
  history?: number;
  /** How often to send a keep-alive comment. Defaults to 15 s. */
  heartbeatMs?: number;
  /** Where the page's files are. Defaults to the packaged `ui/` directory. */
  assets?: string;
  /** How many pages may stream at once; one more gets a 503. Defaults to 32. */
  maxClients?: number;
  /**
   * When set, the page and `/events` need it: as `?token=`, or in the HttpOnly, SameSite=Strict cookie that the page
   * sets when it is opened with `?token=`. The page's code, style and icon stay open.
   */
  token?: string;
}

/** The live view's server; see `createUiServer`. */
export interface UiServer {
  /**
   * Replays the log's end, starts following it, and listens on `host` (127.0.0.1 by default).
   * Resolves to the page URL.
   */
  listen(port: number, host?: string): Promise<string>;
  /** Shows a log entry: `serve --ui` passes each one the router logs. Anything without an `event` is ignored. */
  publish(entry: unknown): void;
  /** Ends every open page stream, stops following the log, and closes the server. */
  close(): Promise<void>;
  /** Open page streams. */
  readonly clients: number;
}

/** Totals of one model in a report. */
export interface ModelTotals {
  requests: number;
  cost_usd: number;
  input: number;
  cache_read: number;
  output: number;
}

/** What `jev-router report` prints: traffic, spend, savings against the baseline, and Jev health. */
export interface Report {
  requests: number;
  sessions: number;
  models: Record<string, ModelTotals>;
  cost_usd: number;
  baseline_usd: number;
  saved_usd: number;
  /** Responses with usage but no price for their model. */
  unpriced_responses: number;
  jev: {
    calls: number;
    fallbacks: number;
    fallback_rate: number;
    p50_ms: number | null;
    p95_ms: number | null;
    /** Estimated at $0.042 per million input tokens. */
    cost_usd: number;
  };
}

// ---------------------------------------------------------------------------------------------
// The router

export interface RouterOptions {
  /** Keys, pins and the router token are read from here. Defaults to `process.env`. */
  env?: Env;
  /** Receives every log entry. Defaults to one JSON line per entry on stdout. */
  log?: (entry: LogEntry) => void;
  /** Used for Jev calls only; upstream requests always use the global `fetch`. */
  fetchImpl?: FetchLike;
  /** A session store to use instead of one built from the config. */
  store?: SessionStore;
}

/** The body of `GET /healthz`. */
export interface Health {
  ok: true;
  version: string;
  uptime_s: number;
  sessions: number;
  /** Requests being handled right now. */
  active: number;
  jev: { configured: boolean; channels: Record<string, ChannelStats & { open: boolean }> };
}

/** What `createRouter` adds to the HTTP server. */
export interface RouterExtras {
  readonly sessions: SessionStore;
  /** Requests being handled right now, for a graceful shutdown. */
  readonly active: number;
  /** Switches to a new validated config. Sessions and requests in flight carry on. */
  reload(next: Config): void;
}

export type RouterServer = Server & RouterExtras;
