# Security policy

jev-router runs on your machine, holds API keys, and sees your prompts on their way to the model providers. Reports
about any way around the boundaries below are welcome.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.5.x | Yes |
| 1.4.x and older | No. Update with `npm install -g github:dirien/jev-router#semver:^1`; for 1.4.x, first run `npm uninstall -g @dirien/jev-router` |

## Reporting a vulnerability

Report vulnerabilities privately, never in a public issue, pull request or discussion.

- **Email** [info@ediri.de](mailto:info@ediri.de) with "jev-router security" in the subject.
- **GitHub**: use [private vulnerability reporting](https://github.com/dirien/jev-router/security/advisories/new)
  (**Security**, then **Report a vulnerability**).

Include the version (`jev-router version`), the config with keys removed, the steps to reproduce, and what an
attacker gains. Don't send real API keys, or prompts that contain secrets.

The maintainer acknowledges the report, works on a fix, and publishes it with a changelog entry and a GitHub security
advisory that credits you unless you'd rather not be named. Please allow
time for the fix before you disclose the issue publicly.

## Scope

### Loopback binding

- The router listens on `127.0.0.1:4000` by default, and refuses to listen on a non-loopback address unless
  `JEV_ROUTER_TOKEN` is set.
- It refuses a `Host` header other than `127.0.0.1`, `localhost` or `[::1]` on its port, which blocks DNS
  rebinding, and any request with an `Origin` header, which blocks cross-site requests from a browser tab. Both can
  be widened with `allowedHosts` and `allowedOrigins`.
- With a token, every proxied request must carry it as `x-jev-router-token`, compared in constant time.
  `GET /healthz` answers without the token and returns only counters and channel health, no keys and no prompts.
- It serves the proxied `/v1/*` routes and `/healthz` only. There is no admin API.

### The live view

- The view is read-only and has its own port. It listens on `127.0.0.1` unless `--ui` or `JEV_ROUTER_UI` names
  another address, and says so on stderr when that address isn't loopback and the view has no token.
- It answers only a `Host` that names loopback or the address it listens on, so DNS rebinding can't reach it, and
  refuses a foreign `Origin`. It serves its page, the page's script, style and icon, and the event stream, and sends
  a Content Security Policy that allows only its own origin. It takes at most 32 open pages.
- With `--ui-token` or `JEV_ROUTER_UI_TOKEN`, the page and the event stream need that token, compared in constant
  time. The first visit brings it as `?token=`; the page then keeps it in an `HttpOnly`, `SameSite=Strict` cookie and
  drops it from the address bar. The page's script, style and icon stay open, because they're the published source.
  Prefer the variable to the flag: other users on the machine can see a flag in `ps`.
- The view shows log entries: models, tiers, costs and decisions. It never shows prompt text or keys, because the
  log holds neither.

### Secret handling

- Upstream and Jev keys come from environment variables. Each key goes only to the host of the target or Jev channel
  that names it, and upstream redirects are refused, so a key can't follow one.
- On a plain machine, the keys live in an env file, `~/.config/jev-router/env`, which every command loads when it
  exists (or the file `--env-file` or `JEV_ROUTER_ENV_FILE` names). `jev-router setup` writes it with mode 0600, and
  never prints a key, not even in part. `serve`, `launch`, `env`, `doctor` and `setup` warn, with the `chmod` to run,
  when other users can read or change it.
- `launch` keeps the env file's variables out of the agent's environment, so the commands Claude Code or Codex runs,
  and the tool output an untrusted upstream receives, don't carry the router's keys.
- The client's own credential, such as a Claude login, is forwarded only to targets marked `clientAuth`
  and `trusted` whose key isn't set (Anthropic in the packaged configs).
- So that another gateway's credentials never reach Anthropic, `jev-router setup`, `launch claude` and `env claude`
  won't route Claude Code while it goes to another gateway (`ANTHROPIC_BASE_URL`) with credentials for it:
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, custom headers other than the router token, or an `apiKeyHelper`. They
  name those variables, never their values, and say what to remove.
- A deterministic scanner checks every human message. A hit keeps the session on the `trusted` target, and pins,
  tags and Jev's answer can't override that.
- Untrusted targets get secrets redacted anywhere in the body, tool output included, a minimal set of headers, and
  no `metadata`.
- Jev's state is scrubbed before it's truncated, and it never includes tool output, file contents or the system
  prompt.

### What the router stores

- **The state file**, `~/.local/state/jev-router/sessions.jsonl` by default, with mode 0600 in a directory with
  mode 0700. It holds SHA-256 hashes of session IDs, tiers, trust flags, turn counts, the client's model name, the
  last upstream host, and a hash of the message where the provider changed. It holds no prompt text. Entries expire
  after seven days.
- **The logs**, on stdout and in the log file when one is set (`--log-file`, `JEV_ROUTER_LOG_FILE` or `logFile`),
  with mode 0600. A log file rotates to `<file>.1` at `logMaxBytes`. The service templates and `jev-router launch`
  log to `~/.local/state/jev-router/router.log`. The logs hold routing decisions, Jev's probabilities, token usage
  and cost, and no prompt text or keys.

The router writes nothing else to disk. Of the other commands, `jev-router init` writes the config file,
`jev-router launch` a `launch-<port>.pid` file next to its log while it runs, and `jev-router launch codex` the Codex
profile, `~/.codex/jev.config.toml`, with mode 0600, since it may hold the router token.

`jev-router setup` writes:

- the config and the env file, both with mode 0600, in a directory with mode 0700;
- the service file, a launchd agent or a systemd user unit, which holds paths and a `PATH`, and no keys;
- Claude Code's `settings.json`, with the router token in `ANTHROPIC_CUSTOM_HEADERS` when the router has one. It
  keeps the file's mode (0600 for a new file), without access for other users once the file holds the token, and a
  backup of the old file, `settings.json.jev-router.bak`, with mode 0600;
- `~/.config/jev-router/setup.json`, mode 0600, its record of what it changed for `jev-router uninstall`, which holds
  no keys and no router token.

Run through npx, setup installs the package globally with `npm install -g` after you agree, so the service never runs
from npx's cache. Setup and `uninstall` refuse to run as root on another user's behalf, through `sudo` or with that
user's `HOME`, so they never leave files owned by root in a user's home.

### Out of scope

- A credential format the secret scanner doesn't know. The scanner is a documented best effort; new patterns are
  welcome as ordinary issues or pull requests.
- Attacks that need code running as your user, which can read the env file, the router's environment and its keys
  anyway.
- Access you widened on purpose, through `allowedHosts`, `allowedOrigins` or a non-loopback address for the router
  or the live view.
- Vulnerabilities in Claude Code, the Codex CLI, the model providers, TypeSafe, OpenRouter or Docker Sandboxes.
  Report those to their vendors.
- What the model providers and the Jev channel do with the data they receive. See their terms.
