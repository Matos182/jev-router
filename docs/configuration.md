# Configuration reference

jev-router reads one JSON file. This page lists every key with its default and its validation, the environment
variables, and the three packaged configs. The source of truth is `validateConfig` in
[`src/config.mjs`](../src/config.mjs) and the shipped [`config/default.json`](../config/default.json).

## Where the config comes from

The router uses the first of these that exists:

1. the file passed with `--config <file>`
1. the file in `JEV_ROUTER_CONFIG`
1. `$XDG_CONFIG_HOME/jev-router/config.json`, which is `~/.config/jev-router/config.json` when `XDG_CONFIG_HOME` is
   unset
1. the packaged [`config/default.json`](../config/default.json)

`jev-router setup` writes `~/.config/jev-router/config.json` when there's no config yet: from
[`config/anthropic-only.json`](../config/anthropic-only.json) by default (`--models claude`), from
[`config/anthropic-fable.json`](../config/anthropic-fable.json) with its Fable option (`--models fable`), or from the
packaged default with its Ollama option (`--models ollama`). Run again, setup asks again, and Enter keeps what you have.
It replaces the config only when it's still an unchanged copy of a packaged one, from this release or an earlier one,
so nothing you changed is lost; any other config, and one that `JEV_ROUTER_CONFIG` names, stays as it is, and setup
prints the `init` command that starts over. Neither setup nor `init` writes through a link into jev-router's own
package. `jev-router init` writes the packaged default
as a starting point, and `jev-router init --models <name>` another packaged config (`--anthropic-only` is
`--models claude`); `init` doesn't overwrite an existing file unless you pass `--force`.

The file is plain JSON, without comments. The router validates it at startup and exits with every problem listed,
and again on `SIGHUP`, where an invalid file leaves the running config in place. Keys the router doesn't know are
ignored, not rejected, so a misspelled optional key keeps its default without a warning.

## Packaged configs

| File | Claude Code | Codex CLI |
| --- | --- | --- |
| [`config/default.json`](../config/default.json) | `fast`: Ollama Cloud `glm-5.3-flash`. `balanced` and `trusted`: Anthropic `claude-sonnet-5`. `frontier`: Anthropic `claude-opus-5-5`. `side`: Anthropic `claude-haiku-4-5` | `fast`: Ollama Cloud `glm-5.3-flash`. `balanced`: Ollama Cloud `kimi-k2.7-code`. `frontier`: OpenAI `gpt-6-astra`. `trusted`: OpenAI `gpt-6-sol` |
| [`config/anthropic-only.json`](../config/anthropic-only.json) | Like the default, except that `fast` is Anthropic `claude-haiku-4-5`, with the same `omit` list as `side`. `jev-router setup` writes this one unless you pick another option | Same as the default |
| [`config/anthropic-fable.json`](../config/anthropic-fable.json) | Like the Anthropic-only config, plus a fourth tier, `max`: Anthropic `claude-fable-5-1`. Jev's `deep` option, the `fable` model pin and `#max` go there | Same as the default, with `max` on OpenAI `gpt-6-astra`, like `frontier` |

All three share the Jev channels, the rubric, the prices and the policy's thresholds. The Fable config differs from
the Anthropic-only one only where the `max` tier needs it: the tier itself with a `policy.accept` of 0.3, the `deep`
option, `modelPins.fable`, a `policy.escalationCeiling` of `frontier`, and `baselineModel`, which is Fable 5.1, so
savings compare against running everything on Fable 5.1. The ceiling keeps the step up after a missed bar on Opus
5.5, so a message reaches Fable 5.1 only when `deep` is Jev's most likely answer, or through a pin, a `#max` tag or
the risk override (`policy.sensitiveOverride`), which sends a request to the top tier, `max` there. The
OpenAI model names come from Codex's bundled model catalog; check them against your account.

A session keeps its tier across a config change. When the new config lacks that tier, as `max` after a switch from
the Fable config to another, the session goes on with the new config's top tier, never a cheaper one. Its model
changed, so its prompt cache is cold anyway: the next message you write gets a fresh decision, which may go down.

## Server keys

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `host` | `"127.0.0.1"` | A non-empty string. A non-loopback address needs a token, or the router refuses to start | Listen address. `--host` and `JEV_ROUTER_HOST` override it |
| `port` | `4000` | Integer from 1 to 65535 | Listen port. `--port` and `JEV_ROUTER_PORT` override it |
| `token` | none | none | Shared secret that every proxied request must carry as `x-jev-router-token`. `JEV_ROUTER_TOKEN` overrides it. `/healthz` doesn't need it |
| `allowedHosts` | `[]` | An array of strings | `Host` header values (`host:port`) accepted besides `127.0.0.1`, `localhost` and `[::1]` on the router's port |
| `allowedOrigins` | none | An array of strings | `Origin` header values to accept. Any request with another `Origin` gets a 403, which keeps browser tabs out |
| `maxBodyBytes` | `33554432` (32 MiB) | A whole number above 0 | Larger request bodies get a 413 |
| `maxSessions` | `10000` | A positive whole number | Sessions kept in memory and in the state file; the least recently used ones are dropped first |
| `stateFile` | `"$XDG_STATE_HOME/jev-router/sessions.jsonl"`, or `"~/.local/state/jev-router/sessions.jsonl"` | A file path or `null`. A leading `~/` is expanded | Where decisions persist across restarts. `null` keeps them in memory only |
| `logFile` | `null` | A file path or `null`. A leading `~/` is expanded | A file to append the JSON log lines to, besides stdout (mode 0600). For `serve`, `--log-file` and `JEV_ROUTER_LOG_FILE` override it |
| `logMaxBytes` | `52428800` (50 MiB) | A whole number, 0 or more | The size at which a log file rotates. `0` turns rotation off |

The state file is created with mode 0600 in a directory with mode 0700. The router appends a JSON line whenever a
session's entry changes, keyed by a SHA-256 hash of the session ID: tier, trust flag, provisional state, turn count,
the client's model name, the last upstream host, and a hash of the human message where the provider changed. Entries
older than seven days are dropped. The router rewrites the file to one line per live session at startup, and again
while it runs, once the appended lines outnumber the larger of 1,000 and the sessions it holds. It never holds prompt
text.

### The log file

`serve` always writes its JSON log lines to stdout. It also appends them to the first of these that's set:

1. the file passed with `--log-file`
1. `JEV_ROUTER_LOG_FILE`
1. `logFile` in the config

`serve` creates the directory of a file named by `--log-file` or `JEV_ROUTER_LOG_FILE` (mode 0700), and a leading
`~` there means your home directory, for services that start without a shell. A router that `launch` starts writes
`~/.local/state/jev-router/router.log` (`$XDG_STATE_HOME/jev-router/router.log` when that's set), and `logFile` too
when it's set.

A file that a line would take past `logMaxBytes` is renamed to `<file>.1` first, replacing the previous `<file>.1`,
so the router keeps two files at most. The line goes into the new file. A symbolic link isn't rotated. A file that
can't be written costs its own lines and never a request: the router logs one `warning` to its other outputs, notes
the problem on stderr, and says on stderr when the file can be written again.

`jev-router report` and `jev-router ui` look for the log in the same order, after an argument: `JEV_ROUTER_LOG_FILE`,
then `logFile`, then the log that `launch` writes. `report` reads `<file>.1` too, unless you name the file.

## Tiers and routing rules

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `tiers` | none, required | A non-empty list of strings | Tier names, cheapest first. Shipped: `["fast", "balanced", "frontier"]`, plus `"max"` in the Fable config |
| `defaultTier` | none, required | One of `tiers` | The tier a new session gets when Jev can't decide, and the reference a fresh session's decision is compared against. Shipped: `"balanced"` |
| `sideCallModel` | `"haiku"` | A string that compiles as a regular expression | A case-insensitive regular expression. When a request carries no request class, a matching model name marks it as a background call |
| `pinOnModelChange` | `true` | `true` or `false` | When the client switches to another model family (for example `/model opus` in Claude Code), pin the session to that family's tier |
| `modelPins` | `{}` | Each value must be one of `tiers` | Model family to tier. Families are `fable`, `opus`, `sonnet` and `haiku`. Shipped: `fable` and `opus` to `frontier`, `sonnet` to `balanced`, `haiku` to `fast`; the Fable config pins `fable` to `max` |

## policy

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `policy.mode` | `"ratchet"` | `"ratchet"` or `"sticky"` | `ratchet` asks Jev at every new human message and only moves a session up. `sticky` asks once per session |
| `policy.accept` | `0.6` for every tier | Each value a probability from 0 to 1, keyed by a name in `tiers` | The probability Jev's most likely tier needs to be taken as is. Shipped: `fast` 0.85, `balanced` 0.6, `frontier` 0.3, and `max` 0.3 in the Fable config |
| `policy.escalationCeiling` | the top tier | One of `tiers` | When Jev's most likely tier misses its bar, the router takes the more capable of Jev's two most likely tiers, but no higher than this one. A tier above it serves only a message that Jev rates most likely for it, a pin, a tag or the risk override. The Fable config sets `frontier` |
| `policy.sensitiveOverride` | `0.7` | A probability | When `alters_sensitive_state` reaches this, the request goes to the top tier |
| `policy.claimGuard` | `0.5` | A probability | When `routing_claim_present` reaches this, the decision can't go below the reference tier |
| `policy.maxProvisional` | `3` | A whole number, 0 or more | How many failed Jev attempts a new session allows before its fallback tier sticks |
| `policy.idleResetMinutes` | `10` | A number, 0 or more | After this many minutes without traffic, the next human message is decided afresh, because the prompt cache has most likely expired |
| `policy.failClosed` | `false` | `true` or `false` | Keep provisional sessions, which Jev hasn't answered for yet, on the `trusted` target |

How the policy turns Jev's answer into a tier, in order:

1. Option probabilities are summed per tier (`mechanical` to `fast`, `routine` to `balanced`, `complex` and `deep` to
   `frontier` in the shipped rubric).
1. If the most likely tier reaches its `accept` value, it's taken (`reason: jev`). Otherwise, if the second most
   likely tier is more capable and has any probability, that one is taken (`reason: jev-escalated`).
1. `alters_sensitive_state` at or above `sensitiveOverride` forces the top tier (`reason: risk-override`).
1. `routing_claim_present` at or above `claimGuard` lifts a decision below the reference tier to the reference
   (`reason: claim-guard`).
1. In an ongoing session, a result at or below the current tier keeps the current tier (`reason: jev-keep`), and a
   higher one is an upgrade (`reason: upgrade:<reason>`).

A session is decided afresh, without the ratchet, when it's new, still provisional, idle for longer than
`idleResetMinutes`, or its history shrank since the last request (compaction, or a fork of the conversation). The
reference tier is `defaultTier` for a fresh decision and the current tier otherwise.

When no Jev channel answers, a new session gets `defaultTier` and stays provisional: Jev is asked again on its next
human message, up to `maxProvisional` attempts (`reason: fallback:default`). An ongoing session keeps its tier
(`reason: fallback:keep`). When no channel has a key at all, every new session gets `defaultTier`
(`reason: no-jev`), and the log carries a warning once.

## jev

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `jev.deadlineMs` | `2500` | A whole number above 0 | The total time for one decision, across channels and retries |
| `jev.requestChars` | `4000` | A whole number above 0 | Size cap for the latest human message in Jev's state. Longer text keeps a quarter of the cap from its start and the rest from its end, where the question usually is |
| `jev.stripCode` | `true` | `true` or `false` | Accepted, but the router doesn't read it yet: code blocks are always replaced by a one-line summary |
| `jev.guards` | `true` | `true` or `false` | Ask the two guard questions, `alters_sensitive_state` and `routing_claim_present`, in the same request as the tier question |
| `jev.channels` | `[]` | An array of objects. Each channel needs a `name`, an http(s) `baseUrl`, a `model` and a `keyEnv` | System One channels, tried in order |
| `jev.channels[].timeoutMs` | `1200` | A whole number above 0 | Timeout for one attempt on this channel |
| `jev.question` | none, required | A non-empty string | The instructions of the tier question |
| `jev.options` | none, required | At least two options, each with a `tier` from `tiers` | The tier question's options |

The router calls `POST {baseUrl}/v1/systemone` with `Authorization: Bearer <key>` and a body of `model`, `state` and
`questions`. A channel is used only when the environment variable named by its `keyEnv` is set, and its key is only
ever sent to its own `baseUrl`. The shipped channels:

| `name` | `baseUrl` | `model` | `keyEnv` |
| --- | --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai` | `jev-1.13.0` | `TYPESAFE_API_KEY` |
| `openrouter` | `https://openrouter.ai/api` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` |

Pin a model version rather than an alias such as `jev-latest`: TypeSafe moves the alias when it ships a new version,
and thresholds tuned on one version don't carry over. `JEV_BASE_URL` and `JEV_API_KEY` add a channel named `env` in
front of the list, with `JEV_MODEL` as its model (default `jev-1.13.0`) and a 1,200 ms timeout. Any server that speaks
the System One API works there.

How the channels fail over, within `deadlineMs`:

- A response with status 408, 429, 500, 502, 503, 504 or 529 gets one retry on the same channel, after the server's
  `retry-after` delay (150 ms without one), if that still fits in the deadline.
- A 403 with an HTML body comes from the provider's edge firewall, not from the API. It gets one retry with a hardened
  state, in which URLs, file paths and command names become placeholders and shell metacharacters are removed.
- After a timeout or a network error, the channel is skipped for 30 seconds. After a 401, 402 or 403, it's skipped for
  5 minutes.
- Then the next channel is tried. When none answers, the policy falls back as described above.

Each option in `jev.options` has a `tier` and the fields Jev sees: in the shipped rubric, `what`, `examples` and
`not_for`. The router removes `tier` before sending, so Jev judges the work and never sees a tier or model name. The
option names (`mechanical`, `routine`, `complex`, `deep`) are sent, and their order stays fixed. After any change to
`jev.question` or `jev.options`, re-run the [evaluation](evaluation.md) before relying on the thresholds.

## surfaces

`surfaces` maps the router's two client protocols to upstream targets. `surfaces.anthropic` serves `/v1/messages`
and `/v1/messages/count_tokens` (Claude Code), and `surfaces.openai` serves `/v1/responses` (Codex). A surface needs
one target per name in `tiers`, plus:

- `trusted`, required when any tier's target isn't `trusted`. It serves sessions that contained a secret, and, with
  `failClosed`, provisional ones.
- `side`, optional, for background calls. Without it, background calls use the cheapest tier's target.

Validation reports a missing target for any tier, and a surface that routes some tier to an untrusted target
without a `trusted` target marked `"trusted": true`.

| Target key | Required | Validation | Meaning |
| --- | --- | --- | --- |
| `url` | yes | An http(s) URL | Upstream base URL. The request path and query string are appended |
| `stripPath` | no | A path such as `"/v1"` | A leading path segment removed from the request path before it is appended to `url`. ChatGPT's Codex backend serves `/responses` under `https://chatgpt.com/backend-api/codex`, so a target there sets `"/v1"` |
| `model` | yes | A non-empty string | The model name written into the forwarded request |
| `auth` | yes | `"x-api-key"` or `"bearer"` | How the router sends its key |
| `keyEnv` | this or `clientAuth` | none | Environment variable that holds the key for this target |
| `clientAuth` | this or `keyEnv` | none | Needs `trusted`. When the router has no key for this target, forward the client's own `authorization`, `x-api-key` and `chatgpt-account-id` headers. Use it only for a first-party provider: Anthropic, to keep a Claude login working, or ChatGPT's Codex backend, to keep a ChatGPT login working |
| `trusted` | no | none | Trusted with secrets and with the client's full headers |
| `countTokens` | no | none | `false` answers `count_tokens` with a local 404 instead of forwarding the prompt to a counter with another tokenizer |
| `omit` | no | A list of strings | Fields to delete from the request body before forwarding. Dotted paths reach nested fields, for example `output_config.effort` |
| `maxOutputTokens` | no | A positive whole number | The most output tokens the model accepts. A larger `max_tokens` (or `max_output_tokens`) is lowered to it, and a thinking budget stays below it. Defaults to the measured limits of known Claude models: 64000 for `claude-haiku-4-5`, 128000 for `claude-sonnet-5`, `claude-opus-5-5` and `claude-fable-5-1`. Claude Code sizes `max_tokens` for the model it thinks it talks to, so a cheaper tier needs this |
| `foldSystemMessages` | no | `true` or `false` | Folds `role: "system"` messages inside `messages` into the user message each follows, as `<system-reminder>` text after its tool results; the tools they add (`tool_addition` blocks) join `tools`. Claude Code sends them to the Claude 5 family; Haiku 4.5 answers "role 'system' is not supported on this model". Defaults to `false` for `claude-sonnet-5`, `claude-opus-5-5` and `claude-fable-5-1`, and `true` for every other model |
| `omitBetas` | no | A list of strings | Beta flags to drop from the `anthropic-beta` header. Defaults to `["context-1m-2025-08-07"]` for `claude-haiku-4-5`: Claude Code asks for the 1M-context beta once its own model has a 1M window, and Haiku 4.5 answers "The long context beta is not yet available for this subscription" |

When `keyEnv` names a variable that's set, the router's key wins over the client's credential, so setting
`ANTHROPIC_API_KEY` bills every Anthropic request to that key instead of the Claude login.

An untrusted target (`trusted` unset or false) gets less of the request: secrets redacted anywhere in the body,
tool output included, only the `content-type`, `accept`, `anthropic-version`, `anthropic-beta`, `openai-beta` and
`user-agent` headers, and no `metadata`.

The shipped `omit` list, on `surfaces.anthropic.side` and on `fast` in the Anthropic-only config, removes the adaptive
`thinking`, `output_config.effort` and `context_management` that Claude Code sends for a current model. Haiku 4.5
rejects them with a 400. Ollama Cloud targets set `countTokens: false`, because Ollama Cloud has no `count_tokens`
endpoint.

## Prices and the baseline

| Key | Default | Validation | Meaning |
| --- | --- | --- | --- |
| `prices` | `{}` | none | USD per million tokens per model: `in`, `out`, and optionally `cacheRead` and `cacheWrite`, which fall back to `in` |
| `baselineModel` | none | none | Per surface, the model whose prices `baseline_usd` uses. Shipped: `{"anthropic": "claude-opus-5-5"}`, and `{"anthropic": "claude-fable-5-1"}` in the Fable config |

Each `done` log line carries `cost_usd`, the request's usage priced on the model that served it, and `baseline_usd`,
the same usage priced on the surface's baseline model. `jev-router report` adds them up and shows the difference as
the savings. A model name with a date suffix (`claude-haiku-4-5-20251001`) falls back to the undated price entry. A
response from a model without a price counts as `unpriced_responses` in the report.

The shipped prices, per million tokens:

| Model | Input | Output | Cache read | Cache write |
| --- | --- | --- | --- | --- |
| `claude-haiku-4-5` | $1 | $5 | $0.10 | $1.25 |
| `claude-sonnet-5` | $2 | $10 | $0.20 | $2.50 |
| `claude-opus-5-5` | $4 | $20 | $0.20 | $5 |
| `claude-fable-5-1` | $10 | $50 | $0.25 | $12.50 |
| `glm-5.3-flash` | $0.15 | $0.50 | $0.03 | same as input |
| `kimi-k2.7-code` | $0.95 | $4 | $0.19 | same as input |

The OpenAI models have no shipped prices. Add them to `prices` to include Codex's frontier and trusted tiers in the
ledger.

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | The shipped `typesafe` channel | Jev through TypeSafe |
| `OPENROUTER_API_KEY` | The shipped `openrouter` channel | Jev through OpenRouter |
| `OLLAMA_API_KEY` | Ollama Cloud targets | Sent as a bearer key |
| `OPENAI_API_KEY` | OpenAI targets | Sent as a bearer key |
| `ANTHROPIC_API_KEY` | Anthropic targets | Optional. When it's unset, Claude Code's own credential goes to Anthropic |
| `JEV_ROUTER_ENV_FILE` | `serve`, `launch`, `env`, `doctor`, `setup`, `uninstall` | The env file to load instead of `$XDG_CONFIG_HOME/jev-router/env` when `--env-file` isn't given. `setup` saves the keys there. `/dev/null` turns the env file off, and then `setup` stops, having nowhere to save keys |
| `JEV_ROUTER_CONFIG` | Config lookup | The config file, after `--config`. `setup` keeps it as it is and gives it to the service |
| `XDG_CONFIG_HOME` | Config lookup, the env file, `setup` | Base directory for `jev-router/config.json`, `jev-router/env` and `jev-router/setup.json`. The systemd unit goes under the systemd user manager's own `XDG_CONFIG_HOME`, as `systemctl --user show-environment` reports it, else `~/.config` |
| `XDG_STATE_HOME` | The state file, `launch` | Base directory for the default `stateFile` and for the log that `launch` writes (`~/.local/state` when unset) |
| `JEV_ROUTER_HOST`, `JEV_ROUTER_PORT` | Every command that finds the router | Listen address, overriding `host` and `port`. `setup` saves them in the env file when your shell sets them, so the service and every other command read the same address |
| `JEV_ROUTER_LOG_FILE` | `serve`, `report`, `ui` | The log file, after `--log-file` and before `logFile` |
| `JEV_ROUTER_TOKEN` | The router, `launch`, `env` | Shared secret sent as `x-jev-router-token`, overriding `token`. Required for a non-loopback address |
| `JEV_ROUTER_UI` | `serve`, `launch`, `setup` | The live view's address, like `--ui`: a port or `host:port`. `setup` gives the service this address instead of 4100 |
| `JEV_ROUTER_UI_TOKEN` | `serve`, `ui` | The live view's token, like `--ui-token`. Unlike the flag, it doesn't show in `ps` |
| `JEV_ROUTER_TIER` | The router | Pins every main-loop request of every session to this tier. An unknown tier name is logged and ignored |
| `JEV_ROUTER_CLAUDE_BIN`, `JEV_ROUTER_CODEX_BIN` | `launch` | The `claude` and `codex` binaries to run |
| `JEV_ROUTER_SETUP_WAIT` | `setup` | How many seconds to wait for the service's router to answer; 15 by default |
| `CLAUDE_CONFIG_DIR` | `setup`, `uninstall`, `doctor` | Where Claude Code's `settings.json` is: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json` |
| `CODEX_HOME` | `launch codex`, `env codex` | Where the Codex profile goes: `$CODEX_HOME/jev.config.toml`, else `~/.codex/jev.config.toml` |
| `JEV_BASE_URL`, `JEV_API_KEY`, `JEV_MODEL` | The Jev client | Add a channel in front of `jev.channels`. Both `JEV_BASE_URL` and `JEV_API_KEY` must be set |

The key variables are the `keyEnv` names in the shipped configs. A config can name any variable instead.

`jev-router setup` merges the router's variables into the `env` block of Claude Code's `~/.claude/settings.json`
(`$CLAUDE_CONFIG_DIR/settings.json` when that's set), once the router it started answers: `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_GATEWAY_HINT_HEADERS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `ENABLE_TOOL_SEARCH` unless they're set,
and `ANTHROPIC_CUSTOM_HEADERS` when the router has a token. It keeps the file's other keys and their order, writes it
with 2-space indentation, keeps its mode (0600 for a new file, and no access for other users once it holds the router
token), and backs it up first to `settings.json.jev-router.bak`, which only you can read. A settings file that is a
symbolic link stays one. A variable whose value isn't a string, such as `"ENABLE_TOOL_SEARCH": true`, is yours: setup
never overwrites it, and `uninstall` never removes it.

Setup asks before it replaces a base URL that points elsewhere, in the file or in your shell, and leaves a file that
isn't valid JSON alone. It never replaces one when Claude Code also carries credentials for that gateway
(`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, custom headers, or `apiKeyHelper`), because behind the router they'd go
to Anthropic; `launch claude` and `env claude` refuse then too.

What setup changed goes into `$XDG_CONFIG_HOME/jev-router/setup.json`, without keys or the router token, for
`jev-router uninstall`. `jev-router doctor` reads the settings file, without changing it, to check that block.

### The env file

Any of these variables can come from an env file instead of the shell: a file of `KEY=value` lines,
`~/.config/jev-router/env` (`$XDG_CONFIG_HOME/jev-router/env`) with mode 0600, which `jev-router setup` writes.
`serve`, `launch`, `env`, `doctor` and `setup` load that file when it exists, or the file named by
`--env-file <file>`, else by `JEV_ROUTER_ENV_FILE`, with Node's own loader, before they read anything else from the
environment. Messages call the usual file the "default location". Naming `/dev/null` turns the env file off.

- A variable that's already set wins over the file.
- A leading `~` in the path is your home directory, for services that start without a shell.
- A file that other users can read or change gets a warning with the `chmod 600` that fixes it. `setup` rewrites the
  file with mode 0600.
- Variables that Node reads only when it starts, such as `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY` and
  `NODE_EXTRA_CA_CERTS`, have no effect from the file, and get a warning.
- Node checks an `--env-file` path itself. A missing file ends the command with `node: <path>: not found` and exit
  status 9, before jev-router runs. A file named by `JEV_ROUTER_ENV_FILE`, or a `~/.config/jev-router/env` that
  exists but can't be read, stops the command with jev-router's own error. A missing `~/.config/jev-router/env` is
  fine.
- `setup` changes only the lines of the keys it asks for, and of a `JEV_ROUTER_HOST` or `JEV_ROUTER_PORT` your shell
  sets, and keeps every other line and comment. It quotes a value only when Node's loader would otherwise misread it,
  for example one with a `#`. An env file that is a symbolic link stays one.
- The file is read once. `SIGHUP` reloads the config, not the env file, so restart the router after a key change.
- `launch` keeps the file's variables out of the agent's environment.

## Validation messages

Every problem is reported at once, for example:

```text
Invalid router config:
  - port must be an integer between 1 and 65535
  - defaultTier "Balanced" is not one of tiers
  - policy.accept.fast must be a probability
  - surfaces.anthropic has no target for tier "frontier"
```

| Check | Message |
| --- | --- |
| `port` | `port must be an integer between 1 and 65535` |
| `host` | `host must be an address or a host name` |
| `allowedHosts` | `allowedHosts must be an array of host[:port] strings` |
| `allowedOrigins` | `allowedOrigins must be an array of origins` |
| `maxBodyBytes` | `maxBodyBytes must be a whole number of bytes above 0` |
| `maxSessions` | `maxSessions must be a positive integer` |
| `stateFile`, `logFile` | `stateFile must be a file path or null`, `logFile must be a file path or null` |
| `logMaxBytes` | `logMaxBytes must be a whole number of bytes, or 0 to never rotate` |
| `sideCallModel` | `sideCallModel must be a regular expression, such as "haiku"` |
| `pinOnModelChange` | `pinOnModelChange must be true or false` |
| `tiers` | `tiers must list tier names, cheapest first` |
| `defaultTier` | `defaultTier "…" is not one of tiers` |
| `policy.mode` | `policy.mode must be "ratchet" or "sticky"` |
| `policy.accept` | `policy.accept names unknown tier "…"`, `policy.accept.<tier> must be a probability` |
| `policy.escalationCeiling` | `policy.escalationCeiling "…" is not one of tiers` |
| Guard thresholds | `policy.sensitiveOverride must be a probability`, `policy.claimGuard must be a probability` |
| Other policy keys | `policy.maxProvisional must be a whole number, 0 or more`, `policy.idleResetMinutes must be a number of minutes, 0 or more`, `policy.failClosed must be true or false` |
| `jev` settings | `jev.deadlineMs must be a whole number of milliseconds above 0`, `jev.requestChars must be a whole number above 0`, `jev.stripCode must be true or false`, `jev.guards must be true or false` |
| `jev.channels` | `jev.channels must be an array`, `jev.channels[i] must be an object`, `jev.channels[i].name is required`, `….baseUrl must be an http(s) URL`, `….model is required`, `….keyEnv is required`, `….timeoutMs must be a whole number of milliseconds above 0` |
| `jev.question`, `jev.options` | `jev.question is required`, `jev.options needs at least two options`, `jev.options.<name>.tier must be one of tiers` |
| `surfaces` | `surfaces is required`, `surfaces.<surface> has no target for tier "…"`, `surfaces.<surface> routes some tiers to untrusted upstreams, so it needs a trusted target marked "trusted": true` |
| Targets | `….url must be an http(s) URL`, `….model is required`, `….auth must be "x-api-key" or "bearer"`, `… needs keyEnv or clientAuth`, `….clientAuth needs trusted`, `….stripPath must be a path prefix such as "/v1"`, `….omit must be a list of field paths`, `….maxOutputTokens must be a positive whole number`, `….foldSystemMessages must be true or false`, `….omitBetas must be a list of beta names` |
| `modelPins` | `modelPins.<family> must be one of tiers` |

Several of these checks catch values that would otherwise break routing much later. A `sideCallModel` of `"("` would
fail each main Codex request with a 500, and `"failClosed": "false"` would turn fail-closed on, because a non-empty
string counts as true.
