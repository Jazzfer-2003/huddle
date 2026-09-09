# Add your agent in 15 lines

Every guest in huddle is a JSON manifest. To bring a new CLI agent to the table:

1. Copy `adapters/_template.json`
2. Save it as `~/.huddle/adapters/<name>.json` (or PR to `adapters/`)
3. Edit the four fields:

```json
{
  "name": "myagent",
  "command": "myagent",
  "argsTemplate": ["--headless", "--model", "{model}"],
  "promptVia": "stdin",
  "models": [{ "id": "default", "label": "My Default", "tier": "free" }],
  "defaultModel": "default"
}
```

| Field | Meaning |
|---|---|
| `command` | The executable on PATH |
| `argsTemplate` | CLI args; `{model}` is replaced by the chosen model id |
| `promptVia` | `"stdin"` (we pipe the prompt) or `"arg"` (we append it as the last argument) |
| `models` | What `models` shows — id, label, tier (`free`/`paid`/`local`) |

Optional: `"adviseArgs"` (read-only flags your CLI supports, used in advise mode), `"outputFormat": "json"` (if your CLI can emit JSON for cleaner parsing).

That's it — `ask(agent="myagent", ...)` works immediately. PR it in with a one-line README addition and we'll merge fast.

## Tips

- If the CLI can't run headless (no way to pass a prompt + get an answer), it can't be a guest yet — ask upstream for a headless flag.
- Test with: `myagent --headless "say hi" </dev/null` — if that prints a reply, an adapter will work.
