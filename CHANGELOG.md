# Changelog

All notable changes to jev-router are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional `jev.channels[].keepAlive` warms keyless local Ollama models at startup and reload, and renews residency
  on successful decisions. Expired or loading channels are skipped immediately; timeouts start a separate load.
  Health and doctor show residency; negative durations keep it forever, and values Ollama would refuse are refused.

- A System One channel on a loopback address (`127.0.0.0/8`, `::1` or `localhost`) can omit `keyEnv`. The router calls
  it with no `Authorization` header, so a local Ollama 0.35 server (`POST /v1/systemone`, models such as `nimble` and
  `tev1`) can decide a tier with no API key. A keyless channel on any other host is refused when the config loads.
  `JEV_BASE_URL` alone is that channel when the host is loopback; `JEV_MODEL` defaults to `nimble` there. On any
  other host it is ignored, and `doctor` warns. No configured key is sent to a keyless channel. The model that answered
  is the route log's `jev.model`.
- Every loopback Jev channel is called directly, not through `HTTP_PROXY` when `NODE_USE_ENV_PROXY=1` is set, so the
  routing state sent to a local model stays on the machine. An injected `fetchImpl` is still used for every channel.
- `jev-router setup` works with a config whose Jev channels are all local: it asks for no Jev key, with or without
  `--yes`.
- `jev.channels[].thresholds` overrides `policy.accept`, `policy.sensitiveOverride` and `policy.claimGuard` for that
  channel. The packaged policy stays a starting point for Jev. It is not a calibration for nimble or tev1, and a field
  left unset falls back to it on purpose.
  A decision is judged by the thresholds of the channel that answered it, so two channels with the same name, such as
  a configured `env` and the `JEV_BASE_URL` shortcut, never borrow each other's.
- The direct call to a loopback channel behaves like fetch: it decodes a gzip, deflate or br body, or a list of those
  codings, and a status fetch cannot represent (outside 200 to 599) or a body that does not decode fails that channel
  instead of stopping the router. A loopback `baseUrl` with a user or password in it is refused when the config loads,
  since the request would carry them as Basic auth.
- For a local channel, choice criteria are written out as the description strings Ollama requires. A question type
  outside Ollama's `choice`, `noul` and `score` fails that channel the way a failed Jev call does: the next channel
  decides, and when none answers, a new session gets `defaultTier` and an ongoing one keeps its tier.
  `jev-router doctor` reports the local channel; `doctor --live` reports whether it answered.

## [1.6.0] - 2026-09-25

Fable 5.1 can take Claude Code's hardest work now. Setup offers a third choice of models, Claude with Fable 5.1, which
adds a fourth tier, `max`, for the messages Jev rates most likely deep. Run setup again to switch between the choices.

### Added

- `config/anthropic-fable.json`: the Claude-only config plus a `max` tier on `claude-fable-5-1`. A message goes there
  when `deep` is Jev's most likely answer, and so do `/model fable` and a `#max` tag. A message Jev thinks would change
  production systems, credentials, permissions or billing goes to the top tier, which is `max` in this config. Otherwise
  it routes like the Claude-only config. Savings compare against running every request on Fable 5.1. Codex's `max` tier
  is `gpt-6-astra`, like its `frontier` tier.
- `policy.escalationCeiling`: when Jev's most likely tier misses its bar, the router takes the more capable of Jev's two
  most likely tiers, but no higher than this tier. Unset, as in the other packaged configs, it's the top tier, so their
  routing doesn't change. The Fable config sets `frontier`, so an unsure message never jumps to Fable 5.1: with a fourth
  tier, an answer 84% mechanical with the rest split between complex and deep would have gone there.
- `jev-router setup --models fable`, and Claude with Fable 5.1 as the second answer to setup's models question. The
  Ollama option moves from `2` to `3`.
- `jev-router init --models claude|fable|ollama` writes any of the packaged configs. `--anthropic-only` still works, as
  `--models claude`.

### Changed

- Running setup again asks for the models again, and Enter keeps the ones you have. Pick others, or pass `--models`, and
  setup switches the config and restarts the service with it. It replaces the config only while it's an unchanged copy
  of a packaged config, from this release or an earlier one; an edit saved while setup runs wins. A config you changed,
  or one that `JEV_ROUTER_CONFIG` names, stays as it is, and setup prints the `init` command that starts over.
- Setup and `init` never write through a link into jev-router's own package, such as a user config linked to a packaged
  one: they say to remove the link instead.

### Fixed

- A session whose tier the config no longer has, after a switch to another config, went on with the cheapest tier: after
  a switch away from the Fable config, a session on Fable 5.1 would have run its next tool steps on Haiku 4.5. It now
  goes on with the config's top tier, and the next message you write gets a fresh decision.

## [1.5.0] - 2026-09-25

Starting jev-router takes one command now. `jev-router setup` asks which models Claude Code uses and for the keys,
checks the Jev key, runs the router in the background and points Claude Code at it; `jev-router uninstall` takes it
back out. jev-router is on npm now, as `@ediri/jev-router`, so `npx @ediri/jev-router setup` followed by `claude` is
the whole start. The repository and the Docker Sandboxes kit are public.

### Added

- `jev-router setup`, an interactive setup that is safe to run again. It asks which models Claude Code uses (Claude
  only, the default, or Ollama Cloud's `glm-5.3-flash` for the `fast` tier) and for the keys that config needs,
  hidden on a terminal, with Enter keeping a saved key. It checks the Jev key with one real call (about $0.00003),
  and writes nothing until a key works. Then it writes the config and the env file (mode 0600, its other lines kept),
  installs a launchd agent or a systemd user unit from the packaged templates, waits for the router to answer, and
  merges the router's variables into `~/.claude/settings.json` with a backup. A base URL that points elsewhere, in the
  settings file or the shell, is replaced only on a yes. `--yes` takes the defaults and the keys from the environment;
  `--models`, `--service` and `--no-claude-settings` choose the rest. Without a service manager, as in a container or
  a Mac session without a GUI login, setup saves the keys and says to start sessions with `jev-router launch claude`.
  It runs for the user who starts it, and refuses root on another user's behalf, through `sudo` or with their `HOME`.
- Another gateway's credentials stay away from Anthropic. When Claude Code goes to another gateway
  (`ANTHROPIC_BASE_URL`) with credentials for it (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, custom headers, or an
  `apiKeyHelper`), setup doesn't point it at the router, and `launch claude` and `env claude` refuse: behind the router,
  Claude Code would send those credentials to Anthropic. They name the variables and where they're set, never their
  values, and say what to remove. When such a gateway turns up in the shell after setup pointed Claude Code at the
  router, `doctor` reports a FAIL line, and running setup again takes its own settings back out.
- Run through npx, as `npx @ediri/jev-router setup` or `npx github:dirien/jev-router setup`, setup installs the package
  globally before it installs the service, because npm can delete its npx cache at any time. When `npm install -g`
  fails, it says what to do, and names 1.4.0's package when that one holds the command. The commands setup suggests are
  the ones that work for you: `jev-router`, its path, or the npx form.
- `jev-router uninstall` stops and removes the service, and takes setup's variables back out of Claude Code's
  settings, restoring the values setup replaced and leaving the ones you changed since. It reads
  `~/.config/jev-router/setup.json`, where setup records its changes without keys, and makes a careful guess without
  it. It keeps the config, the keys and the logs, and prints the command that deletes them.
- `launch --ui [<host>:]<port>`, or `JEV_ROUTER_UI`: a router that `launch` starts also serves the live view, whose
  address `launch` prints before the agent starts.
- `doctor` has a `service` line: none installed, or which service and whether its router answers. When the service
  answers and `settings.json` points at it, `doctor` says to start Claude Code as usual.
- `JEV_ROUTER_SETUP_WAIT`, how long setup waits for the service's router to answer: 15 seconds by default.
- `JEV_ROUTER_ENV_FILE=/dev/null` (or `--env-file /dev/null`) turns the env file off.
- The package smoke test also runs `setup --yes --service none` against a local Jev stand-in, and `uninstall`.

### Changed

- The npm package is now `@ediri/jev-router`, under the npm account that holds the author's other packages, and 1.5.0 is
  its first release on npm. Nothing was published under the old name, and GitHub installs work as before. If you
  installed 1.4.0, the old package `@dirien/jev-router` owns the `jev-router` command: run
  `npm uninstall -g @dirien/jev-router` before you install 1.5.0, or npm stops with `EEXIST` on the command's link.
- `serve`, `launch`, `env` and `doctor` load `~/.config/jev-router/env` (`$XDG_CONFIG_HOME/jev-router/env`) when it
  exists, so `--env-file` is needed only for another file. The rules stay the same: variables already set win, a loose
  mode or a startup-only variable gets a warning, and `launch` keeps the file's variables away from the agent.
  `doctor` reports the file with an ok line, where it used to say the file wasn't loaded. Setup saves a
  `JEV_ROUTER_HOST` or `JEV_ROUTER_PORT` from the shell in that file, so the service and every other command find the
  router at the same address.
- The service templates pass `--config ~/.config/jev-router/config.json`, so setup and the manual route install the
  same service; the manual route starts with `jev-router init`. The systemd install commands no longer add
  `/usr/local/bin` to the service's `PATH`, which the router never needed.
- The README leads with the commands that start jev-router, and the manual steps move to "Manual setup" in
  `docs/activation.md`. The everyday examples drop `--env-file`.
- The repository and the Docker Sandboxes kit on GHCR are public. The GitHub installs need only git, the kit pulls
  without a login, and the notes about access to a private repository or package are gone.

### Fixed

- An env file that exists but can't be read was reported as "no such file", because Node's loader says so. It now
  reads "permission denied".
- A Jev key with a character an HTTP header can't carry, such as a NUL or a line break inside it, made the Jev
  client's error quote the whole `authorization` header, key included, into the log and `/healthz`. The error now says
  what's wrong without it, and a key that a Jev server echoes back is cut from the error too.

## [1.4.0] - 2026-09-25

jev-router now installs and runs on any Mac or Linux machine with Node.js 22 or newer, without a clone of the
repository and without Docker Sandboxes: install it with npm, keep the keys in an env file, and run it as a launchd
or systemd service.

### Added

- Install without a clone: `npm install -g github:dirien/jev-router#semver:^1` installs the newest 1.x release, and
  `#v1.4.0` pins one. Run the command again to update, and `npm uninstall -g @dirien/jev-router` to remove it.
- A release workflow for version tags. It checks and packs the package, publishes the Docker Sandboxes kit to
  `ghcr.io/dirien/jev-router-kit` under the version and `latest`, and creates the GitHub Release with the tarball and
  `SHA256SUMS`. Once the `NPM_PUBLISH` repository variable is on, it also publishes `@dirien/jev-router` to npm with
  provenance. `docs/releasing.md` describes it.
- Service templates in the package: a macOS LaunchAgent and a systemd user unit under `examples/service/`. Both run
  `jev-router serve --ui 4100` with the keys from `~/.config/jev-router/env` and a rotating log, and their headers
  have the install, use and uninstall commands.
- `--env-file <file>` for `serve`, `launch`, `env` and `doctor`, or `JEV_ROUTER_ENV_FILE`: loads `KEY=value` lines
  before anything reads the environment, and variables already set win. A file that other users can read or change
  gets a warning, and so do proxy settings in it, which Node reads only at startup. `launch` keeps the file's
  variables out of the agent's environment.
- `serve --log-file <file>`, or `JEV_ROUTER_LOG_FILE`, ahead of the config's `logFile`. `serve` creates the file's
  directory, and `report` and `ui` read the same file when you don't name one.
- `logMaxBytes`, 50 MiB by default: a log file that would grow past it is renamed to `<file>.1`, and one old file is
  kept. `0` turns rotation off. `report` reads `<file>.1` too.
- `--ui-token`, or `JEV_ROUTER_UI_TOKEN`: the live view asks for the token. `serve` and `ui` print an address that
  carries it, and the page keeps it in a cookie.
- New `doctor` checks: the env file (what it sets, a loose mode, or a `~/.config/jev-router/env` that isn't passed),
  the log file (a missing or unwritable directory, and when it rotates), and Claude Code's settings. When
  `ANTHROPIC_BASE_URL` in the shell or in `~/.claude/settings.json` points at the router, `doctor` names each
  recommended variable that's missing, `ENABLE_TOOL_SEARCH=true` among them.
- `npm run test:package`, a smoke test that installs the packed package the way users do (and with `--git`, the last
  commit), then runs `version`, `init`, `serve` with an env file and the live view, `env claude`, `launch claude` and
  a clean `SIGTERM`, without network access. CI runs it on Node.js 22 and 24.
- `docs/comparison.md` compares jev-router with LiteLLM, Jevonian, gargpratyush/jev-router and
  Switchboard.

### Changed

- A stream that the upstream breaks off now logs an `error` line plus a `done` line with the usage so far and an
  `error`, even when the status was 200. It used to leave only an `error` line reading "terminated", so its cost never
  reached `report`. The client's response is now cut off rather than ended, so it can't pass for a whole response.
- A client that leaves before the upstream answers now gets a `done` line with status 499, like a client that leaves
  during the Jev call, instead of an upstream error.
- The Docker Sandboxes kit allows `github.com` and `codeload.github.com`, so a sandbox can install jev-router with
  npm, and it gains `sourceURL` and `licenses`. Its version now comes from the release.
- The README and the guides lead with a plain Mac or Linux machine. The Docker Sandboxes guide covers only what
  differs there, and uses the kit from GHCR or git instead of a clone.

### Fixed

- `serve` crashed at its next message to stderr once stderr had closed, so a `serve 2>&1 | tee` that lost `tee` went
  down at the next config reload.
- A log file that couldn't be written (a missing directory, a permission, a full disk) lost every line without a
  word. Now its first failure is one `warning` line and one note on stderr, and `serve` says when it works again.
- A slow client left two listeners behind at every pause of a stream, so memory grew with each pause of a long
  stream, and Node printed a `MaxListenersExceededWarning`.
- An upstream that couldn't be reached showed up as "Upstream request failed: fetch failed". The 502 and the `error`
  line now name the host and the cause, such as `getaddrinfo ENOTFOUND ollama.com` or a TLS error.
- Concurrent requests of one human turn share one Jev call, but the call ran on the first request's abort signal:
  when that client left, the others lost Jev's answer. The call now ends only when every request waiting for it has
  left.
- A client that left before the Jev call, or while it waited to retry, counted as a Jev failure against a new
  session's provisional attempts.
- A `SIGHUP` right after `serve` said it was listening could end the router, because the signal handlers came after
  that line.
- A second `SIGINT` or `SIGTERM` during the 30-second drain did nothing, so an impatient Ctrl-C needed a `SIGKILL`.
  It now stops `serve` at once. A drain that runs out of time says how many requests it cut.
- Config validation let through values that broke routing later: a `sideCallModel` that isn't a regular expression,
  a channel `timeoutMs` of 0 or `"fast"`, `"failClosed": "false"`, which turned fail-closed on, a `maxBodyBytes` of 0
  or `"32mb"`, and a `stateFile` or `logFile` given as a number, among others. The router now stops at startup and
  names each one.
- A long-running router grew without bound in a few places. The state file is now compacted while the router runs,
  not only at startup. The router remembers at most 100 warnings, the live view takes at most 32 open pages, the
  usage tap drops an SSE line without a newline past 8 MiB, and a Jev channel's error text is cut to 200 characters.

## [1.3.3] - 2026-09-24

### Fixed

- After `/model` to a model with a 1M window, every Claude Code request routed to Haiku 4.5 failed with "The long
  context beta is not yet available for this subscription": Claude Code asks for the 1M-context beta on every
  request. The router now drops beta flags a target's model rejects, built in for Haiku 4.5's
  `context-1m-2025-08-07`, with a new `omitBetas` per target.
- A folded system message that added or removed tools failed with "'tool_addition'/'tool_removal' blocks are
  only permitted within `role: "system"` messages". Folding now adds the tools such a message defines to
  `tools`, loads a deferred tool it references, and leaves removals out, so a removed tool stays available.

## [1.3.2] - 2026-09-24

### Fixed

- A background call selected in the live view showed its prompt's verdict (for example "the session never moves
  down → frontier") although it went to `side`. Background calls and token counts don't run on the session's tier,
  so they no longer inherit a prompt's decision: the panel reads "Background call · Jev not asked" and explains
  that these calls always take the side target and never change the session's tier.

## [1.3.1] - 2026-09-24

### Fixed

- Every Claude Code turn routed to Haiku 4.5 failed once with "role 'system' is not supported on this model", and
  Claude Code retried it. Claude Code puts `role: "system"` messages inside the conversation for the Claude 5
  family; the router now folds them into the user message each follows, as `<system-reminder>` text after its tool
  results, for any other model. The `done` line counts them in `folded_system`, and a target's new
  `foldSystemMessages` overrides the default.
- Claude Code compacted on every message behind the router: it turns MCP tool search off for a base URL that isn't
  Anthropic's and sends every MCP tool's definition with every request, which with a few MCP servers exceeds the
  compaction window by itself. `launch claude`, `env claude` and `examples/claude-code.env` now set
  `ENABLE_TOOL_SEARCH=true`, unless it's already set; the router forwards tool search as is.
- The live view now spells out when the router passes over the tier Jev's choice maps to: the line under the
  category reads, for example, "82% sure · Jev's tier fast ✗ 82% is under its 85% bar → balanced", and the flow
  marks that tier. The flow no longer scrolls by a pixel on a container of fractional width.

## [1.3.0] - 2026-09-24

### Added

- Click a request in the live view (or focus it and press Enter) to inspect it: the decision panel shows its Jev
  answer, reason and route, and the flow streams its path, from the client through the router, Jev's category and
  the tier to the model, in its tier's color while the rest of the graph dims. A tool step, subagent or background
  call shows the prompt whose decision it runs on. Escape or **Back to live** returns to the traffic; the button
  counts the requests that arrived meanwhile. While following live, the flow streams the newest request's route,
  faster while it is in flight.

## [1.2.1] - 2026-09-24

### Fixed

- Claude Code turns routed to Haiku 4.5 failed with a 400: Claude Code asks for `max_tokens: 128000`, sized for the
  Opus 5.5 it believes it talks to, and Haiku 4.5 accepts at most 64000. The router now lowers `max_tokens` (and
  `max_output_tokens`) to what the target's model accepts, keeps a thinking budget below it, and says so in the
  `x-jev-max-tokens` header and the `capped_max_tokens` field of the `done` line. The limits of Haiku 4.5 and the
  Claude 5 family are built in; a target's new `maxOutputTokens` overrides them.

### Added

- The `done` line carries the upstream's error message for a failed request, and the live view shows it.

## [1.2.0] - 2026-09-24

### Added

- `jev-router serve --ui [<host>:]<port>` (or `JEV_ROUTER_UI`): the router serves its live view itself, on its own
  port, and feeds it every log entry in-process, so no log file is needed. Config reloads show up in the view.
  Listening on `0.0.0.0` lets a forwarded port (`sbx ports`) reach it from outside a Docker Sandbox, with a warning
  on stderr. A view that can't listen is reported, and routing goes on without it.

### Changed

- The live view checks only the host name of the `Host` header, not its port, so a port forwarded under another
  number works. It still answers only loopback names and the address it listens on.

## [1.1.0] - 2026-09-24

### Added

- `jev-router ui [<log.jsonl>] [--port <n>]`: a live, animated view of routing in the browser on
  `http://127.0.0.1:4100`. It shows Jev's category and probabilities for each human message, the tier and model the
  router picked and why, every request's path from the client through Jev to the model, a timeline with tokens and
  cost, each session's tier history, and spend against the baseline. It follows the log by polling, so it also works
  across a Docker Sandbox's shared workspace folder.
- Log lines for the view: `req` pairs each `route` line with its `done` line, `deciding` marks a Jev call before its
  answer, and `config` lists the tiers, Jev's options and each target's model and host (never keys) at startup and
  after every reload.

## [1.0.0] - 2026-09-24

First release.

### Added

- A pass-through router for Claude Code (`/v1/messages`, `/v1/messages/count_tokens`) and the Codex CLI
  (`/v1/responses`). It changes only `model`, the credential and the fields a target rejects, and streams responses
  back byte for byte.
- Tier decisions by Jev on new human messages only. Tool-loop steps, subagents, compaction and background calls
  follow the session's tier, and a session only moves up (`policy.mode: "ratchet"`) or is decided once
  (`"sticky"`).
- A small, scrubbed Jev state, and one tier question with guards for sensitive operations and routing claims.
  Asymmetric per-tier thresholds escalate to the more capable tier when Jev is unsure.
- Jev channel failover (TypeSafe, then OpenRouter, plus an optional `JEV_BASE_URL` channel), one retry within a
  deadline, circuit breakers, a hardened retry after a firewall block, and a provisional fallback to the default tier.
- Deterministic pins and tags: the `x-jev-tier` header, `JEV_ROUTER_TIER`, `#tier` as the first or last typed word,
  and `/model` switches to another model family.
- A secret scanner on every human message that keeps a session on trusted upstreams. Untrusted upstreams get
  redacted bodies, a minimal set of headers and no `metadata`.
- Provider-aware stripping of signed reasoning when a session moves to another upstream host.
- Per-target `omit` lists for fields a model rejects, verified live against Haiku 4.5.
- Loopback binding with `Host`, `Origin` and content-type checks, an optional `x-jev-router-token`, and a refusal
  to listen on other addresses without a token.
- Persistent session state, JSON-line logs with token usage, cost and baseline cost, `jev-router report`,
  `GET /healthz`, config reload on `SIGHUP` and a drain on `SIGTERM`.
- Config validation that lists every problem at startup, and two packaged configs: `config/default.json` and
  `config/anthropic-only.json`.
- The `jev-router` CLI: `serve`, `launch claude`, `launch codex`, `env`, `doctor`, `init`, `report`, `version` and
  `help`.
- Client examples for Claude Code and Codex, including a Codex model catalog that carries Codex's own system prompt.
- A Docker Sandboxes kit for the upstream credentials.
- An offline test suite with mock upstreams and a mock Jev, a live Anthropic check, and a Jev evaluation harness with
  58 labeled prompts.
- Biome, TypeScript (`checkJs`) and markdownlint checks, and CI on Node.js 22 and 24 with actionlint.
- Documentation: activation, configuration reference, design notes, evaluation, and a Docker Sandboxes guide.

[Unreleased]: https://github.com/dirien/jev-router/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/dirien/jev-router/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/dirien/jev-router/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/dirien/jev-router/compare/v1.3.3...v1.4.0
[1.3.3]: https://github.com/dirien/jev-router/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/dirien/jev-router/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/dirien/jev-router/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/dirien/jev-router/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/dirien/jev-router/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/dirien/jev-router/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dirien/jev-router/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dirien/jev-router/releases/tag/v1.0.0
