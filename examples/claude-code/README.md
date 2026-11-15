# Claude Code + securitypay

Two things to set up: Claude Code can reach you (MCP server + skill), and you can
reach Claude Code from your phone (an agent in `agents.yaml`).

## Claude Code reaches you

```bash
securitypay init --relay https://relay.example.com --api-key ak_...
securitypay pair                                   # scan the QR with the app
claude mcp add securitypay -- securitypay mcp        # the send_message / get_replies / call tools
mkdir -p ~/.claude/skills && cp -r ../../skills/securitypay ~/.claude/skills/   # when to use them
```

Calls need the voice extra and a Gemini API key (free tier available at
https://aistudio.google.com/apikey), or the key of another voice provider (OpenAI, Grok,
Phonic: [docs/voice.md](../../docs/voice.md#providers)):

```bash
uv tool install 'securitypay[voice] @ git+https://github.com/mutonby/securitypay#subdirectory=daemon'
echo GEMINI_API_KEY=... >> ~/.securitypay/.env
```

Then, for example: *"Run the migration; if anything fails, call me."*

### Notify when a task is done (hook)

To get a message whenever Claude Code finishes a turn, without the model deciding,
add a `Stop` hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "securitypay msg 'Claude Code finished' >/dev/null" }] }]
  }
}
```

## You reach Claude Code by phone

`~/.securitypay/agents.yaml`:

```yaml
agents:
  claude:
    description: Claude Code in my web app's repo. Code questions, CI status, small fixes.
    command: [claude, -p, --permission-mode, plan, --, "{task}"]   # read-only: it can look, not change
    cwd: ~/code/webapp
    timeout_s: 600
```

```bash
securitypay agents ask claude "What changed on main today?"   # check it works
securitypay serve --ai                                          # answers "Call agent" from the app
```

On the call: *"Ask Claude whether CI is green on main."* The voice AI asks it, tells
you it's working on it, and reads you the gist when it answers. If you've already
hung up, the answer arrives as a message.

Give the phone only what you'd accept from someone holding it: `--permission-mode
plan` keeps Claude Code read-only. Use `--allowedTools` for a narrower set.
