# Configuration

RegardedTrader stores user settings in a single JSON file:

- **Path:** `$REGARDEDTRADER_HOME/config.json`
- **Default:** `~/.regardedtrader/config.json`
- **Permissions:** `0600` on POSIX (owner read/write only)
- **Schema version:** `1`

Both the **`regard` CLI** and the **web Settings page** read/write this file
through the local server's `/config` endpoints. Don't hand-edit it while the
server is running unless you also `kill -HUP` (or restart) the server.

## Schema

```jsonc
{
  "version": 1,
  "activeProvider": "openai",          // or null
  "providers": {
    "openai": {
      "kind": "openai-compatible",
      "label": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",              // never logged or returned over /config GET
      "model": "gpt-4o-mini"
    },
    "ollama": {
      "kind": "openai-compatible",
      "label": "Local Ollama",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "llama3.1:latest"
    },
    "codex": {
      "kind": "cli",
      "label": "codex-cli",
      "backend": "codex-cli",          // "codex-cli" | "claude-cli" | "copilot-cli"
      "command": "codex",              // optional; defaults per backend
      "model": "gpt-5"                 // optional
    }
  },
  "risk": { "maxLossUsd": 500, "maxLegs": 4, "forbidNakedShorts": true },
  "server": { "host": "127.0.0.1", "port": 4317 }
}
```

## Provider kinds

### `openai-compatible`

Anything that speaks `/v1/chat/completions`:

| Service         | Base URL                                  | Notes                          |
| --------------- | ----------------------------------------- | ------------------------------ |
| OpenAI          | `https://api.openai.com/v1`               | needs API key                  |
| Azure OpenAI    | `https://<resource>.openai.azure.com/...` | extra headers may be required  |
| Groq            | `https://api.groq.com/openai/v1`          | needs API key                  |
| OpenRouter      | `https://openrouter.ai/api/v1`            | needs API key                  |
| Together AI     | `https://api.together.xyz/v1`             | needs API key                  |
| Local Ollama    | `http://127.0.0.1:11434/v1`               | keyless                        |
| Local vLLM      | `http://127.0.0.1:8000/v1`                | keyless                        |
| LM Studio       | `http://127.0.0.1:1234/v1`                | keyless                        |

API keys are stored in the file and **never** returned by `GET /config` —
that endpoint returns a redacted view (`sk-1234••••9abc`).

### `cli`

RegardedTrader spawns an installed coding CLI per turn (similar to OpenClaw's
CLI backends). The user installs and authenticates each CLI separately;
RegardedTrader never handles auth itself.

| backend       | default command | how it's invoked                                        |
| ------------- | --------------- | ------------------------------------------------------- |
| `codex-cli`   | `codex`         | `codex exec --json --color never --sandbox workspace-write --skip-git-repo-check` |
| `claude-cli`  | `claude`        | `claude -p --output-format stream-json --verbose`       |
| `copilot-cli` | `gh`            | `gh copilot explain` (richer Copilot Chat support is a follow-up issue) |

You can override the binary path (`command`), append flags (`args`), set the
model (`model`), and inject env vars (`env`) per-provider.

Auth checklist before first use:

```bash
# OpenAI Codex CLI
codex auth login

# Claude Code
claude auth login
claude auth status --text

# GitHub Copilot CLI
gh auth login
gh extension install github/gh-copilot
```

## CLI surface

```bash
regard config            # interactive menu
regard config show       # print the redacted current config + path
```

The interactive menu lets you:

- Add an OpenAI-compatible HTTP provider (with presets for OpenAI / Groq /
  OpenRouter / Ollama / custom).
- Add a CLI backend (Codex / Claude / Copilot).
- Pick the active provider.
- Remove a provider.

## Web surface (Settings)

The Settings view at `/settings` mirrors the CLI: list providers, add/edit/
remove, switch active, run a connection test. It uses the same `/config`
endpoints and shows the same redacted view. Web cannot reveal stored keys.

## Server endpoints

| Method | Path                          | Purpose                                          |
| ------ | ----------------------------- | ------------------------------------------------ |
| GET    | `/config`                     | Redacted current config                          |
| PUT    | `/config`                     | Replace whole config                             |
| POST   | `/config/providers`           | Upsert one provider `{ id, provider }`           |
| DELETE | `/config/providers/:id`       | Remove one provider                              |
| POST   | `/config/activate`            | `{ id }` — set active                            |
| POST   | `/config/test`                | Smoke-test the active provider                   |

All endpoints reject changes that would bind the server to a non-localhost
host. The server hot-swaps the orchestrator after every successful write.
