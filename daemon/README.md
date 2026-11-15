# securitypay daemon

The agent side of [securitypay](https://github.com/mutonby/securitypay): the `securitypay`
CLI, the MCP server (`securitypay mcp`) and the voice AI for calls. It lets your AI
agents message and call your phone, and lets you call them back.

```bash
uv tool install 'securitypay[voice] @ git+https://github.com/mutonby/securitypay#subdirectory=daemon'   # or, from a checkout: uv tool install './daemon[voice]'
securitypay init --relay https://relay.example.com --api-key ak_...
securitypay pair                       # scan the QR with the Android app
securitypay msg "hola"
securitypay call "Testing securitypay" --ai   # needs GEMINI_API_KEY in ~/.securitypay/.env
claude mcp add securitypay -- securitypay mcp
```

Your API key must not cross the internet in clear, so a plain `http://` relay is refused
unless its host is loopback, a private or CGNAT (Tailscale) address, a `.local` name or a
single-label name such as `relay` in Docker. `SECURITYPAY_ALLOW_INSECURE_RELAY=1` lifts this,
for a network you trust that doesn't look like one. The local database is readable by you only.

You need your own relay (self-hosted, Docker compose) and the Android app. See the
[setup guide](https://github.com/mutonby/securitypay/blob/main/docs/setup.md)
and [connecting agents](https://github.com/mutonby/securitypay/blob/main/docs/agents.md).
