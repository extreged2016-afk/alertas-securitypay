# OpenClaw + securitypay

Two things to set up: your OpenClaw assistant can reach you (MCP server + skill), and
you can reach it from a call (an agent in `agents.yaml`). Recipes for other harnesses:
[docs/agents.md](../../docs/agents.md#recipes-by-harness).

## OpenClaw reaches you

The quickest way: install the skill and ask OpenClaw to "set up securitypay"; it walks
you through the rest ([setup guide](../../skills/securitypay/references/setup.md)).

```bash
openclaw skills install @mutonby/securitypay --global
```

Or by hand:

```bash
securitypay init --relay https://relay.example.com --api-key ak_...
securitypay pair                                   # scan the QR with the app
securitypay connect openclaw                       # MCP server, skill and agents.yaml
```

`securitypay connect` registers `securitypay mcp` with a 30-minute tool timeout (OpenClaw's
default is 60 s, shorter than a call), installs the skill and adds OpenClaw to
`~/.securitypay/agents.yaml` (the recipe below). With securitypay cloud, no daemon:
`SECURITYPAY_API_KEY=ak_... securitypay connect openclaw --url https://securitypay.io/mcp`.

Calls need the voice extra and a Gemini API key (free tier available at
https://aistudio.google.com/apikey), or the key of another voice provider (OpenAI, Grok,
Phonic: [docs/voice.md](../../docs/voice.md#providers)):

```bash
uv tool install 'securitypay[voice] @ git+https://github.com/mutonby/securitypay#subdirectory=daemon'
echo GEMINI_API_KEY=... >> ~/.securitypay/.env
```

Then, for example: *"Check my inbox every hour; if something is urgent, call me."*

## You reach OpenClaw by phone

`securitypay connect openclaw` already added an entry like this to `~/.securitypay/agents.yaml`
(with the absolute path of `openclaw` as `$0`, so it works without your PATH):

```yaml
agents:
  openclaw:
    description: My OpenClaw assistant. Messages, calendar, reminders, home.
    command: [sh, -c, 'exec openclaw agent --agent main --session-id "securitypay-${SECURITYPAY_CALL_ID:-test}" --message="$1"', sh, "{task}"]
    timeout_s: 600
```

`openclaw agent` runs one turn through your gateway, so keep it running
(`openclaw gateway`). The `sh -c` script is fixed text: the task arrives as `$1` and
is never parsed by the shell. The call id gives each call its own session, so a
follow-up question keeps the context. Change `main` to use another of your agents.

```bash
securitypay agents ask openclaw "What's on my calendar tomorrow?"   # check it works
securitypay serve --ai                                               # answers "Call agent" from the app
```

On the call: *"Ask OpenClaw to remind me to call the bank at five."* The voice AI
asks it, tells you it's on it, and reads you the answer when it comes. If you've
already hung up, the answer arrives as a message.

The voice AI acts on what it hears: give the phone only the agents and channels you'd
accept from someone holding it.
