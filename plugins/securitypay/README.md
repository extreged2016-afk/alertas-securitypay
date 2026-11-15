# securitypay plugin for Grok Build

Lets Grok reach you on your Android phone through [securitypay](https://securitypay.io):
send a message, wait for your reply, or ring the phone so a voice AI talks to you and
hands the transcript back. No phone number: the call goes over the internet to the
securitypay app.

## Install

```bash
grok plugin install mutonby/securitypay#plugins/securitypay --trust
```

Then:

1. Install the securitypay app from
   [Google Play](https://play.google.com/store/apps/details?id=com.securitypay.alerts) (Android only).
2. Sign in at https://securitypay.io, pair the phone with the QR code on the dashboard
   and copy your API key (`ak_…`).
3. Put the key in the environment Grok Build starts from, for example in your shell profile:

   ```bash
   export SECURITYPAY_API_KEY=ak_...
   ```

4. Start a new Grok session and try: "Send me a message on my phone when the tests finish."

## Components and permissions

- One remote MCP server (`.mcp.json`) with four tools: `send_message`, `get_replies`,
  `call` and `status`.
- One skill (`skills/securitypay`) that tells the agent when to message and when to call,
  and how to help you set securitypay up.

No hooks, scripts, local executables or dependency installs. The tools reach only the
phones paired with your own securitypay account.

## Network and credentials

- `https://securitypay.io/mcp`: the hosted securitypay MCP server (Streamable HTTP). It is the
  only endpoint the plugin calls.
- `SECURITYPAY_API_KEY`: read from your environment and sent to that server as
  `Authorization: Bearer <key>`. The plugin stores no credentials and reads nothing else.

A `call` lasts as long as the conversation. Grok Build's default tool timeout is long
enough; if you lowered it, give this server at least 30 minutes
(`tool_timeout_sec = 1800`).

## Self-hosted

securitypay is open source and you can run your own relay
([setup](https://github.com/mutonby/securitypay/blob/main/docs/setup.md)). In that case skip
this plugin's server and add your own instead:

```bash
grok mcp add securitypay -- securitypay mcp
```

## License and support

Apache-2.0, maintained in https://github.com/mutonby/securitypay (issues welcome there).
Use of the hosted service follows the terms on https://securitypay.io.
