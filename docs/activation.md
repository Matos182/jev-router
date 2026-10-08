# Activating jev-router

This guide connects Claude Code and the Codex CLI to jev-router on your own machine, keeps the router running as a
service, and shows how to check that routing works and how to turn it off again. The examples use the default
address, `http://127.0.0.1:4000`. [configuration.md](configuration.md) covers the config itself.

## Setup

`jev-router setup` does all of this for Claude Code, as the README's [Quick start](../README.md#quick-start) shows.
In order, it:

1. asks which models Claude Code uses: Claude only (Haiku 4.5, Sonnet 5 and Opus 5.5), Claude with Fable 5.1 as a
   fourth tier for deep work, or Ollama Cloud's `glm-5.3-flash` for the `fast` tier and Claude for the rest. It
   doesn't ask when you have a config of your own; when your config is still an unchanged packaged one, Enter keeps it;
1. asks for the keys that config needs for Claude Code: a Jev key (TypeSafe, or OpenRouter when you press Enter),
   and `OLLAMA_API_KEY` for the Ollama option. A key that's saved already stays when you press Enter. On a terminal,
   what you type isn't shown, and a key with a space or a control character in it is asked again;
1. checks the Jev key with one real call (about $0.00003). A key that fails gets another try, and nothing is written
   until one works;
1. asks whether to run the router in the background, when the machine has launchd or a systemd user session;
1. writes `~/.config/jev-router/config.json` if it's new or you picked other models, and saves the keys in
   `~/.config/jev-router/env` (mode 0600), keeping the file's other lines;
1. installs jev-router globally with npm when setup runs from npx, because a service must not run from npx's cache;
1. installs and starts the service, and waits up to 15 seconds for the router to answer. On a re-run, launchd gets up
   to 45 seconds to unload the old agent, whose router may still finish its requests;
1. merges the router's variables into the `env` block of `~/.claude/settings.json`, after a backup to
   `settings.json.jev-router.bak`. The file keeps its mode, except that only you can read it once it holds the router
   token, and the backup is always readable only by you. A settings file or an env file that is a symbolic link, as in
   a dotfiles repository, stays a link: the file it points to is the one that changes.

Setup is safe to run again. It keeps your models and saved keys when you press Enter, and restarts the service, so
new keys and a new config take effect. To switch models, run it again and pick others, or pass `--models`. Setup
replaces only a config that is still an unchanged copy of a packaged one, from this release or an earlier one, and
never writes through a link into jev-router's own package. A config you changed stays as it is, and setup prints the
`init` command that starts over from a packaged one. Without the service, a router that already runs keeps the old
models until it restarts. Its options:

| Option | What it does |
| --- | --- |
| `--yes`, `-y` | Answers every question with its default, and takes the keys from the environment (`TYPESAFE_API_KEY` and so on). It stops, without writing anything, when a key is missing or fails its check |
| `--models claude\|fable\|ollama` | The packaged config to use: Claude only, Claude with Fable 5.1, or Ollama Cloud and Claude. It applies on a machine without a config, or with an unchanged packaged one; the default is `claude`, or the models you have |
| `--service auto\|launchd\|systemd\|none` | `auto`, the default, picks launchd on macOS and systemd on Linux. There's no service on Windows, as root, in a Mac session without a GUI login (over SSH), or where `systemctl --user` doesn't answer, such as in a container |
| `--no-claude-settings` | Installs the service, but leaves `~/.claude/settings.json` alone |

Setup honors `JEV_ROUTER_CONFIG`, `JEV_ROUTER_ENV_FILE`, `JEV_ROUTER_LOG_FILE`, `JEV_ROUTER_HOST`, `JEV_ROUTER_PORT`
and `JEV_ROUTER_UI`. A service doesn't see your shell, so the service gets the config, env file and log file setup
used, with absolute paths, and the live view's address as a flag. A `JEV_ROUTER_HOST` or `JEV_ROUTER_PORT` from your
shell goes into the env file, which the service and every other command read, so `doctor`, `launch`, `env` and
`uninstall` find the router in a new shell too. For the same reason, a `JEV_ROUTER_TOKEN` belongs in the env file.
`JEV_ROUTER_ENV_FILE=/dev/null` turns the env file off, so setup stops: it has nowhere to save the keys.

The systemd unit goes where the user manager looks for units: under the `XDG_CONFIG_HOME` that
`systemctl --user show-environment` reports, else `~/.config/systemd/user/`.

Setup runs for the user who starts it. As root through `sudo`, or as root with another user's `HOME`, it stops before
it writes anything: it would leave files owned by root in that user's home. Run it as your own user, without `sudo`.

When Claude Code already goes to another gateway, setup checks what it would carry there. A base URL in `settings.json`
or in your shell that leads somewhere other than the router or Anthropic counts, unless it's the router address setup
wrote itself. If Claude Code also carries credentials for it, setup never points Claude Code at the router, and says
what to remove first: behind the router, Claude Code would send those credentials to Anthropic. The credentials are
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_CUSTOM_HEADERS` lines other than the router token, in your
shell or the settings file, and an `apiKeyHelper` in the settings file. Setup names them, never their values. Without
credentials, setup asks before it replaces the base URL, the default is no, and `--yes` keeps it. `launch claude` and
`env claude` refuse in the same case, and print the command that leaves the credentials out. When such a gateway and its
credentials turn up in your shell after setup pointed Claude Code at the router, the settings file's address wins and
the credentials go through the router: `doctor` reports that with a FAIL line, and running setup again takes its own
settings back out of the file (or removes the file, if setup created it), so Claude Code goes to the gateway again.

Setup records what it changed in Claude Code's settings in `~/.config/jev-router/setup.json`, with no keys and no
router token. `jev-router uninstall` reads that record: see [Turning it off](#turning-it-off).

## Manual setup

To do each step yourself:

1. Write the config. `jev-router init` copies the packaged default, which sends Claude Code's `fast` tier to Ollama
   Cloud; `jev-router init --models claude` keeps Claude Code on Claude models, and `--models fable` adds Fable 5.1
   for deep work:

   ```bash
   jev-router init --models claude
   ```

1. Save your keys in `~/.config/jev-router/env`, as in [Keys](#keys).
1. Check the setup. `doctor` loads the env file the way the router will, and says what's missing:

   ```bash
   jev-router doctor
   ```

1. Start the router with its live view, and leave it running, or run it [as a service](#run-the-router-as-a-service):

   ```bash
   jev-router serve --ui 4100
   ```

1. In a second terminal, point Claude Code at the router and start it, or pick another way in
   [Claude Code](#claude-code):

   ```bash
   eval "$(jev-router env claude)"
   claude
   ```

## Keys

The router reads its keys from environment variables. On a plain machine, keep them in an env file that only you
can read, `~/.config/jev-router/env`, with one `KEY=value` line per key. `jev-router setup` writes it for you; to
write it yourself:

```bash
touch ~/.config/jev-router/env && chmod 600 ~/.config/jev-router/env
```

```text
TYPESAFE_API_KEY=...
OLLAMA_API_KEY=...
OPENAI_API_KEY=...
```

| Variable | What it's for |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev through TypeSafe |
| `OPENROUTER_API_KEY` | Jev through OpenRouter: a failover for TypeSafe, or instead of it |
| `OLLAMA_API_KEY` | The tiers on Ollama Cloud: Claude Code's `fast` tier in the default config, and Codex's `fast` and `balanced` tiers |
| `OPENAI_API_KEY` | Codex's `frontier` and `trusted` tiers |
| `ANTHROPIC_API_KEY` | Optional. Without it, the router passes Claude Code's own login to Anthropic. With it, the key pays for every Anthropic request |

How the router loads the file:

- `serve`, `launch`, `env`, `doctor` and `setup` load `~/.config/jev-router/env` (`$XDG_CONFIG_HOME/jev-router/env`)
  when it exists. `--env-file <file>`, or else `JEV_ROUTER_ENV_FILE`, names another file instead; there's no need to
  name the usual one.
- A variable that's already set in the environment wins over the file.
- A leading `~` is expanded, because launchd and systemd start the router without a shell.
- The router warns when other users can read or change the file, and prints the `chmod` that fixes it.
- Proxy settings (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY` and the like) and `NODE_EXTRA_CA_CERTS` have no effect from the
  file, because Node reads them only when it starts. Set them in the environment the router starts with; the router
  warns when the file sets them.
- A file that's named but missing stops the command. For `--env-file`, Node checks the path itself, prints
  `node: <path>: not found`, and exits with status 9 before jev-router runs. A missing `~/.config/jev-router/env`
  is fine.
- The file is read once, at startup. After you change a key, restart the router; `SIGHUP` reloads only the config.
- `launch` keeps the file's variables out of the agent's environment, so the commands Claude Code or Codex runs don't
  see the keys from the file.

The file can also hold the router's other settings, such as `JEV_ROUTER_TOKEN` or `JEV_ROUTER_UI_TOKEN`. If you'd
rather keep the keys in your shell environment, export them before you start the router; a service started by setup
reads only the file.

## Claude Code

Every Claude Code setup below sets the same variables:

| Variable | Value | Why |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:4000` | Sends Claude Code's API traffic to the router instead of Anthropic |
| `CLAUDE_CODE_GATEWAY_HINT_HEADERS` | `1` | Labels each request as main loop, subagent, compaction, workflow or background work (Claude Code 2.1.273 and later), so only a person's messages decide the tier |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `160000` | Claude Code can't learn the routed model's context window through a gateway. 160,000 tokens compacts before the smallest window among the tiers |
| `ENABLE_TOOL_SEARCH` | `true` | Claude Code turns MCP tool search off when `ANTHROPIC_BASE_URL` isn't Anthropic's, and then sends every MCP tool's definition with every request. In a live test with a few MCP servers, that was about 200,000 tokens per request, more than the compaction window, so Claude Code compacted on every message. The router forwards tool search as is |
| `ANTHROPIC_CUSTOM_HEADERS` | `x-jev-router-token: <token>` | Only when the router has a token (`JEV_ROUTER_TOKEN`) |

None of them is an API key. Claude Code keeps using your Claude login, and the router passes that credential to
Anthropic and to no other host. Requests that the router sends to Ollama Cloud or OpenAI use the router's own keys.

### One-shot launch

```bash
jev-router launch claude                   # router on 127.0.0.1:4000
jev-router launch claude --port 4001       # another port
jev-router launch claude --ui 4100         # also serve the live view on http://127.0.0.1:4100
jev-router launch claude -- --continue     # arguments after -- go to claude
```

`launch claude` reuses a router that already answers on the port. If none does, it starts one inside its own
process, with the keys from the env file, and that router logs to `~/.local/state/jev-router/router.log`. With
`--ui`, that router also serves the live view, whose address `launch` prints before Claude Code starts. Then it runs
`claude` with the variables above and exits with Claude Code's exit code. Set `JEV_ROUTER_CLAUDE_BIN` to run a
specific `claude` binary.

A router that `launch` started lives only as long as that `launch` process. If you run several Claude Code sessions
at once, start the router separately (`jev-router serve`, or a [service](#run-the-router-as-a-service)), so that
closing the first session doesn't take the router away from the others.

### Environment for the current shell

With the router already running in another terminal or as a service, load the variables into your shell and start
Claude Code as usual:

```bash
jev-router serve --ui 4100         # terminal 1, unless it runs as a service
eval "$(jev-router env claude)"    # terminal 2
claude
```

`jev-router env claude` prints `export` lines for the variables in the table, and warns when nothing answers on the
port yet. Pass the same `--port`, `--config` or `--env-file` as the router uses, if any, so the address and the token
match.
Every `claude` you start from that shell then goes through the router. To stop, open a new shell or unset the
variables:

```bash
unset ANTHROPIC_BASE_URL CLAUDE_CODE_GATEWAY_HINT_HEADERS CLAUDE_CODE_AUTO_COMPACT_WINDOW ENABLE_TOOL_SEARCH ANTHROPIC_CUSTOM_HEADERS
```

[`examples/claude-code.env`](../examples/claude-code.env) holds the same settings as a file you can `source`, plus a
cap on output tokens that `env claude` doesn't set, and commented-out lines for a token or a tier pin. It ships with
the package:

```bash
source "$(npm root -g)/@ediri/jev-router/examples/claude-code.env"
```

### Persistent settings.json

`jev-router setup` does this for you, and `jev-router uninstall` undoes it. To send every Claude Code session through
the router by hand, add an `env` block to `~/.claude/settings.json`, keeping the keys the file already has:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "160000",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
```

The values must be strings. If the router has a token, add `"ANTHROPIC_CUSTOM_HEADERS": "x-jev-router-token: <token>"`
and make the file readable only by you (`chmod 600 ~/.claude/settings.json`). To route only one project, put the
block in that project's `.claude/settings.local.json` instead.

Claude Code now depends on the router. While nothing listens on the port, every request fails with a connection
error, so [run the router as a service](#run-the-router-as-a-service). A value in `settings.json` wins over the
same variable in your shell ([Claude Code docs](https://code.claude.com/docs/en/llm-gateway-connect)), so `unset`
doesn't bypass it.

`jev-router doctor` reads the block (without changing the file). When `ANTHROPIC_BASE_URL` there, or in your shell,
points at the router, it names each of the other three variables that's missing.

To undo it, run `jev-router uninstall`, or delete those keys from the `env` block and restart Claude Code. With `jq`:

```bash
jq 'del(.env.ANTHROPIC_BASE_URL, .env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, .env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, .env.ENABLE_TOOL_SEARCH,
  .env.ANTHROPIC_CUSTOM_HEADERS)' ~/.claude/settings.json > ~/.claude/settings.json.new \
  && mv ~/.claude/settings.json.new ~/.claude/settings.json
```

## Codex CLI

### Codex launch

```bash
jev-router launch codex            # writes or refreshes the profile, then runs codex --profile jev
jev-router launch codex --force    # rewrites the profile first
```

Setup asks only for Claude Code's keys. Add Codex's, `OLLAMA_API_KEY` and `OPENAI_API_KEY`, to
`~/.config/jev-router/env`, then run `jev-router setup` again, so a router running as a service picks them up.

`launch codex` writes the `jev` profile to `~/.codex/jev.config.toml` (`$CODEX_HOME/jev.config.toml` when
`CODEX_HOME` is set). A profile it wrote and nobody edited is refreshed whenever the router's port or token changes; a
profile you edited is kept, with a note, and `--force` replaces it. Like `launch claude`, it reuses a router on the
port or starts one. Arguments after `--` go to `codex`, and `JEV_ROUTER_CODEX_BIN` runs a specific binary. Profile
files need Codex 0.134.0 or newer.

### Codex profile by hand

The profile is [`examples/codex/jev.config.toml`](../examples/codex/jev.config.toml):

1. Copy it to `~/.codex/jev.config.toml`.
1. Set `model_catalog_json` to the absolute path of
   [`examples/codex/jev-models.json`](../examples/codex/jev-models.json).
1. Run `codex --profile jev`.

Both files ship with the package. This does the first two steps:

```bash
examples="$(npm root -g)/@ediri/jev-router/examples/codex"
mkdir -p ~/.codex
sed "s#/absolute/path/to/jev-models.json#$examples/jev-models.json#" "$examples/jev.config.toml" \
  > ~/.codex/jev.config.toml
```

What the profile sets, and why:

- `model = "jev-auto"`: Codex shapes every request (tool types, shell type, parallel tool calls) from the model's
  catalog entry. `jev-auto` is one virtual model whose entry every routed model can handle, and the router picks the
  real model behind it. The entry also carries Codex's own system prompt; an empty one would drop Codex's
  instructions without an error.
- `base_url = "http://127.0.0.1:4000/v1"` and `wire_api = "responses"`, the only wire API current Codex accepts.
- `supports_websockets = false`: WebSockets carry `previous_response_id`, which is stateful, and Ollama Cloud only
  serves stateless Responses.
- `web_search = "disabled"`: Ollama Cloud has no built-in web search on `/v1/responses`.

If the router has a token, let Codex send it from the environment, so it stays out of the file. Add this under
`[model_providers.jev]`:

```toml
env_http_headers = { "x-jev-router-token" = "JEV_ROUTER_TOKEN" }
```

To pin every session started with this profile to one tier, add `http_headers = { "x-jev-tier" = "frontier" }` in
the same table.

### Codex on a ChatGPT login

Codex signed in with ChatGPT (`codex login`) can send its OpenAI tiers to your ChatGPT plan instead of
`OPENAI_API_KEY`. Point those targets at ChatGPT's Codex backend and let the router pass Codex's login through:

```json
"frontier": {
  "url": "https://chatgpt.com/backend-api/codex",
  "model": "gpt-6-astra",
  "auth": "bearer",
  "clientAuth": true,
  "trusted": true,
  "stripPath": "/v1"
}
```

Do the same for `max` and `trusted`, and leave out `keyEnv`: a key the router holds wins over the login. Then
add one line under `[model_providers.jev]` in the profile, so Codex sends its ChatGPT token and account header to
the router:

```toml
requires_openai_auth = true
```

The router forwards the token, and the `ChatGPT-Account-ID` header with it, only to targets with `clientAuth` and
`trusted` whose key isn't set. Ollama Cloud tiers keep their own key and get only content headers, so the login never
leaves for another provider. Use a model your plan offers; `~/.codex/models_cache.json` lists them.

`jev-router launch codex --force` rewrites the profile and drops that line, so add it again after one. The token
travels unencrypted to the router, which is fine on loopback; don't point Codex at a router on another machine.

## Run the router as a service

A service keeps one router running for all your clients, independent of any terminal, and restarts it if it fails.
Session state persists in `~/.local/state/jev-router/sessions.jsonl`, so a restart doesn't move live sessions to
another model.

`jev-router setup` installs the service, and `jev-router uninstall` removes it. This section is the manual route.
The package ships a template for each system, under `$(npm root -g)/@ediri/jev-router/examples/service/`, and setup
writes its service from the same templates. Both run
`jev-router serve --ui 4100 --config ~/.config/jev-router/config.json --env-file ~/.config/jev-router/env --log-file ~/.local/state/jev-router/router.log`:
the router on `http://127.0.0.1:4000`, the live view on `http://127.0.0.1:4100`, your config (so run
`jev-router init` first), and the keys from your env file. The commands below come from each template's header.

`jev-router` starts with `#!/usr/bin/env node`, and a service reads neither your shell profile nor its `PATH`. So the
install commands write the directories that hold `jev-router` and `node` into the service file, which is why
`command -v` must find both first. Run the install commands again after you reinstall jev-router under another
Node.js, for example with nvm.

Both templates log the same way:

- **The JSON log** goes to `~/.local/state/jev-router/router.log` and rotates to `router.log.1` at `logMaxBytes`
  (50 MiB by default). `jev-router report` and `jev-router ui` read it without an argument.
- **Messages for people**, such as startup errors and config reloads, go to
  `~/Library/Logs/jev-router/router.err.log` on macOS and to the journal on Linux.

### macOS launchd

The template is `examples/service/launchd/io.github.dirien.jev-router.plist`, a LaunchAgent with the label
`io.github.dirien.jev-router`. launchd also leaves `~` and `$HOME` unexpanded, so `sed` fills in your home directory
as well.

Install:

```bash
command -v jev-router node                   # both must print a path
jev-router init                              # writes ~/.config/jev-router/config.json
mkdir -p ~/.config/jev-router ~/Library/Logs/jev-router ~/Library/LaunchAgents
touch ~/.config/jev-router/env && chmod 600 ~/.config/jev-router/env
# Put your keys in ~/.config/jev-router/env, one KEY=value per line: TYPESAFE_API_KEY, ...
plist="$(npm root -g)/@ediri/jev-router/examples/service/launchd/io.github.dirien.jev-router.plist"
path="$(dirname "$(command -v jev-router)"):$(dirname "$(command -v node)"):/usr/bin:/bin"
sed -e "s|@HOME@|$HOME|g" -e "s|@PATH@|$path|g" "$plist" > ~/Library/LaunchAgents/io.github.dirien.jev-router.plist
plutil -lint ~/Library/LaunchAgents/io.github.dirien.jev-router.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.dirien.jev-router.plist
```

Use:

```bash
launchctl print gui/$(id -u)/io.github.dirien.jev-router | head    # state and PID
launchctl kill HUP gui/$(id -u)/io.github.dirien.jev-router        # re-read the config
launchctl kickstart -k gui/$(id -u)/io.github.dirien.jev-router    # restart after an upgrade, or a change to the env file
tail -f ~/Library/Logs/jev-router/router.err.log                  # messages and startup errors
jev-router report                                                 # requests, spend and savings
```

The agent starts at login and restarts the router when it exits with an error, for example after a crash. It gives
the router 35 seconds to stop, room for the router's 30-second drain.

Uninstall:

```bash
launchctl bootout gui/$(id -u)/io.github.dirien.jev-router
rm ~/Library/LaunchAgents/io.github.dirien.jev-router.plist
```

### Linux systemd user unit

The template is `examples/service/systemd/jev-router.service`, a user unit named `jev-router`. systemd expands `%h`
to your home directory, so only `PATH` needs filling in.

Install:

```bash
command -v jev-router node                     # both must print a path
jev-router init                                # writes ~/.config/jev-router/config.json
mkdir -p ~/.config/jev-router ~/.config/systemd/user
touch ~/.config/jev-router/env && chmod 600 ~/.config/jev-router/env
# Put your keys in ~/.config/jev-router/env, one KEY=value per line: TYPESAFE_API_KEY, OLLAMA_API_KEY, ...
unit="$(npm root -g)/@ediri/jev-router/examples/service/systemd/jev-router.service"
path="$(dirname "$(command -v jev-router)"):$(dirname "$(command -v node)"):/usr/bin:/bin"
sed "s|@PATH@|$path|" "$unit" > ~/.config/systemd/user/jev-router.service
systemctl --user daemon-reload
systemctl --user enable --now jev-router
loginctl enable-linger "$USER"                 # optional: keep it running while you're logged out
```

Use:

```bash
systemctl --user status jev-router
journalctl --user -u jev-router -f             # messages for people and startup errors
jev-router report                              # requests, spend and savings, from the JSON log
systemctl --user reload jev-router             # SIGHUP: re-read the config
systemctl --user restart jev-router            # after an upgrade, or a change to the env file
```

The unit restarts the router when it fails, and gives up after five failed starts within a minute, for example on a
broken config, which ends the router with exit status 1. It doesn't restart on exit status 9: that is how Node itself
stops, before jev-router runs, when the `--env-file` path is missing or can't be read. Fix the file, then start the
unit again. A user service runs while you're logged in; `loginctl enable-linger "$USER"` keeps it running after you
log out.

Uninstall:

```bash
systemctl --user disable --now jev-router
rm ~/.config/systemd/user/jev-router.service
systemctl --user daemon-reload
```

### Docker Sandboxes

To run the router inside a Docker Sandbox instead, with the keys kept on the host and injected by the sandbox proxy,
follow [sandbox.md](sandbox.md).

## Verifying

1. **`jev-router doctor`** checks the config, the env file and its mode, the keys each target needs, the log file, the
   service, Claude Code's settings, and whether a router answers. `jev-router doctor --live` also makes one real Jev
   call, which costs about $0.00003.
1. **In Claude Code**, `/status` shows `http://127.0.0.1:4000` as the API base URL.
1. **Health.** `curl -s http://127.0.0.1:4000/healthz` returns `"ok": true`, `jev.configured: true`, and one entry
   per Jev channel with its call and error counts.
1. **The live view**, at `http://127.0.0.1:4100` when the router runs as setup's service or with `--ui 4100`, shows
   each request as it arrives.
1. **The log.** Each request writes a `route` line with `tier`, `reason`, `model` and `upstream`, and, on a new
   human message, a `jev` object with the channel, probabilities and latency. `reason: "jev"` means Jev decided;
   `side-call`, `sticky` and `subagent` mean the request followed a rule without asking Jev.
1. **Response headers.** Claude Code doesn't show them, but any client can read `x-jev-tier`, `x-jev-model`,
   `x-jev-reason` and `x-jev-session`:

   ```bash
   curl -si http://127.0.0.1:4000/v1/messages \
     -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
     -d '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"Rename foo to bar in utils.ts"}]}' \
     | grep -iE '^(HTTP/|x-jev-)'
   ```

   This makes one Jev call and one small upstream request. `curl` has no Claude login to pass on, so without
   `ANTHROPIC_API_KEY` a request that lands on Anthropic returns 401; the `x-jev-*` headers still show the decision.

### A routing walkthrough

With real keys, this session exercises each routing rule. Start Claude Code through the router, then watch the
`reason` and `model` of each request in the live view or the log. The models are those of the default config.

| # | Do this | `reason`, model |
| --- | --- | --- |
| 1 | `What does git status -sb print? One sentence.` | `jev`, `glm-5.3-flash` |
| 2 | Same session: `Now list the files changed in the last commit.` | `jev-keep` (or `upgrade:jev` if Jev rates it harder) on the message, then `sticky` on every tool-loop step |
| 3 | Same session: `Find out why the tests in this project could be flaky and fix the cause.` | `upgrade:jev`, `claude-opus-5-5`, then `sticky` |
| 4 | Same session: `thanks!` | `jev-keep`: never back down mid-session |
| 5 | `/clear`, then `Use this key in deploy.sh:` followed by a made-up AWS-style key (`AKIA` plus 16 capital letters or digits) | `secrets: 1` and `trusted_only: true`, served by Anthropic whatever Jev says |
| 6 | `/model` with another model family than the current one, for example `/model sonnet` | `client-model:sonnet`, `claude-sonnet-5` |
| 7 | `/clear`, then `Tidy up the README #frontier` | `tag`, `claude-opus-5-5` |
| 8 | Background calls (automatic) | `side-call`, `claude-haiku-4-5` |

If Jev is less than 85% sure that a message is `fast` work, the router takes the more capable of Jev's top two tiers,
and the reason reads `jev-escalated`. Then run `jev-router report` for the requests, the spend per model, the savings
against Opus 5.5, and Jev's fallback rate and latency.

For Codex, run `jev-router launch codex` and try two sessions:

1. `Create cli.py with a parse_args function, then rename it to parse_cli_args.` This should go to Ollama Cloud, and
   the file edits must actually land. It's the riskiest path in this setup, and it hasn't been verified yet.
1. In a new session: `Design a caching layer for this router and justify the eviction policy.` This should go to
   `gpt-6-astra`. Check that model name against your OpenAI account.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Claude Code can't connect to the API | Nothing listens on the port in `ANTHROPIC_BASE_URL`. Start the router, or remove the settings. |
| Setup says a jev-router already answers on the port | A router you started yourself, with `jev-router serve` or `launch`, holds the port, and the service would fail next to it. Stop that router and run setup again, or pick another port with `JEV_ROUTER_PORT`. |
| Setup says the router didn't answer within 15 seconds | The service started, but its router didn't come up. Read `~/Library/Logs/jev-router/router.err.log` (macOS) or `journalctl --user -u jev-router` (Linux). Claude Code's settings stay as they were until the router answers. |
| Setup's `npm install -g` fails with `EACCES` | npm may not write to its global directory, as with a system Node. Use a Node version manager (nvm, fnm, or Homebrew on a Mac), or `npm config set prefix ~/.local` with `~/.local/bin` on PATH, or install with `sudo`. Then run setup again: it keeps your config and keys. |
| Setup's `npm install -g` fails with `EEXIST` | jev-router 1.4.0 or older, then called `@dirien/jev-router`, owns the `jev-router` command. Run `npm uninstall -g @dirien/jev-router`, then setup again. |
| Setup says there's no background service | The machine has no launchd or systemd user session, as in a container. Start sessions with `jev-router launch claude`. |
| Setup says it won't run as root | You ran it with `sudo`, or as root with another user's `HOME`. Run it as your own user, without `sudo`. |
| Setup doesn't point Claude Code at the router, and names credentials | Claude Code goes to another gateway with credentials for it, which the router would pass on to Anthropic. Remove what setup names, from your shell's startup files or the settings file, open a new shell, and run setup again. |
| `launch claude` or `env claude` refuses, and names credentials | The same: your shell sends Claude Code to another gateway with credentials for it. Run the command it prints, which leaves them out. |
| `node: <path>: not found`, exit status 9 | The `--env-file` path doesn't exist, or can't be read. Check the path; a systemd unit doesn't restart on this. |
| A warning that other users can read or change the env file | Run the `chmod 600` the warning prints. |
| A warning that a variable in the env file has no effect | Proxy settings and `NODE_EXTRA_CA_CERTS` work only in the environment the router starts with: your shell, or the service file. |
| `reason: "no-jev"` in the log | No Jev channel has a key in the router's environment. Check the env file with `jev-router doctor`, and restart the router after you change it. |
| A changed key has no effect | The env file is read at startup, and `SIGHUP` reloads only the config. Restart the router, or run `jev-router setup` again, which restarts its service. |
| `reason: "fallback:default"` or `"fallback:keep"` with a `jev.error` | Jev didn't answer. `/healthz` shows each channel's `lastError`. `HTTP 401` or `403` means a wrong key, and `HTTP 402` an OpenRouter account without credits. A failing channel is skipped for 30 seconds after a timeout and for 5 minutes after a 401, 402 or 403. |
| A warning that Claude Code requests carry no request class | `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` isn't set, or Claude Code is older than 2.1.273. Background calls can't be told apart reliably without it. |
| Claude Code compacts on every message | `ENABLE_TOOL_SEARCH=true` is missing. `jev-router doctor` says so when Claude Code points at the router. |
| The service doesn't answer on `/healthz` | Read `~/Library/Logs/jev-router/router.err.log` (macOS) or `journalctl --user -u jev-router` (Linux). A broken config stops the router at startup with every problem listed. |
| `cannot write the log file …` | The log file's directory is missing or not writable. The router keeps routing, and says when the file works again. |
| The live view answers 401 | It has a token. Open the address the router printed, which ends in `?token=`. |
| The live view answers 503 | More than 32 pages are open on it. Close some. |
| `403 Host "…" is not allowed` | The client used a host name other than `127.0.0.1`, `localhost` or `[::1]` with the router's port, for example through a published port. Add that `host:port` to `allowedHosts`. |
| `403 Cross-origin requests are not allowed` | The request carried an `Origin` header, as browsers do. Add the origin to `allowedOrigins` only if you mean to allow it. |
| `401 Missing or wrong x-jev-router-token header` | The router has a token. Send it through `ANTHROPIC_CUSTOM_HEADERS` (Claude Code) or `env_http_headers` (Codex). |
| The router exits with "Refusing to listen on … without a token" | A non-loopback host needs `JEV_ROUTER_TOKEN`. |
| The router exits with "Invalid router config" | Fix each problem it lists, then start it again. |
| A 502 that names a host and a cause, such as `getaddrinfo ENOTFOUND` | The router couldn't reach that upstream: DNS, the network or TLS. The `error` line in the log has the same text. |
| 401 from Ollama Cloud | `OLLAMA_API_KEY` is missing or wrong. Ollama Cloud only accepts a bearer key. |
| 400 from Anthropic about `thinking`, `effort` or `context_management` on Haiku | That target has no `omit` list. Compare it with `surfaces.anthropic.side` in the packaged config. |
| Codex warns about an unknown model or uses the wrong tools | `model_catalog_json` isn't the absolute path to `jev-models.json`. |
| A session stays on `frontier` | That's the ratchet: mid-session the tier only moves up. `/clear` starts a new session, and a session idle for `policy.idleResetMinutes` (10 by default) is decided afresh. |

## Turning it off

- **`setup`:** run `jev-router uninstall`. It stops and removes the service, and takes out of Claude Code's settings
  what setup put there, restoring a value setup replaced. It changes only variables that still hold setup's value,
  never a value that isn't a string, and backs up `settings.json` first. When it can't read `settings.json`, it keeps
  its record, so that running it again after you fix the file finishes the job. Without setup's record, it removes
  only a base URL that points at the router, with the gateway settings that hold exactly setup's values; after
  `setup --no-claude-settings`, it leaves the settings alone. It keeps your config, keys and logs, prints the command
  that deletes them, and ends with the one that removes jev-router: `npm uninstall -g @ediri/jev-router`. Running it
  twice is fine. Like setup, it won't run as root on another user's behalf.
- **`launch`:** nothing to undo. Plain `claude` and `codex` don't go through the router.
- **Shell variables:** open a new shell, or run the `unset` line from
  [Environment for the current shell](#environment-for-the-current-shell).
- **`settings.json`:** delete the keys from the `env` block (see
  [Persistent settings.json](#persistent-settingsjson)) and restart Claude Code.
- **Codex profile:** `rm ~/.codex/jev.config.toml`. Codex without `--profile jev` uses your default settings.
- **launchd:** run the uninstall commands in [macOS launchd](#macos-launchd).
- **systemd:** run the uninstall commands in [Linux systemd user unit](#linux-systemd-user-unit).
- **Docker Sandboxes:** see the teardown in [sandbox.md](sandbox.md#teardown).
- **Everything:** after the above, `npm uninstall -g @ediri/jev-router`, then
  `rm -rf ~/.local/state/jev-router ~/.config/jev-router`, which also deletes your env file.
