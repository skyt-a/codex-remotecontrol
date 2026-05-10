# codex-remotecontrol

`codex-remotecontrol` is a small web app for controlling local Codex app-server sessions from a browser on the same machine or LAN.

It starts Codex app-server on loopback, exposes only a token-protected Node bridge to the network, and provides a mobile-friendly UI for threads, turns, streaming output, approvals, model selection, sandbox settings, and image input.

## Requirements

- Node.js 22 or newer
- Codex CLI with `codex app-server`
- A trusted local network

Check the Codex side first:

```bash
codex app-server --help
```

## Run

```bash
npm install
npm run phone
```

The server prints URLs like:

```text
http://127.0.0.1:8787/?token=...
http://192.168.x.x:8787/?token=...
```

Open the LAN URL from your phone or another browser on the same network.

## Configuration

Environment variables:

- `PORT` or `CODEX_REMOTE_PORT`: web bridge port, default `8787`
- `HOST` or `CODEX_REMOTE_HOST`: web bridge host, default `0.0.0.0`
- `CODEX_REMOTE_TOKEN`: access token. If omitted, `.phone-token` is created.
- `CODEX_REMOTE_CWD`: default Codex working directory, default current directory
- `CODEX_APP_SERVER_WS`: loopback Codex app-server URL, default `ws://127.0.0.1:45213`
- `CODEX_BIN`: Codex executable, default `codex`

## Security Notes

- Do not expose this app to the public internet.
- Codex app-server is started on `127.0.0.1`; the LAN-facing part is this bridge.
- Anyone with the token can operate Codex from the browser.
- Use `workspace-write` or `read-only` unless you intentionally need broader access.

## Scripts

```bash
npm run check
npm run build
npm run server:smoke
```

`build` currently runs the same checks because the app uses native browser JavaScript and Node built-ins without a bundler.

## References

- OpenAI Codex remote connections: https://developers.openai.com/codex/remote-connections
- OpenAI Codex app-server: https://developers.openai.com/codex/app-server
- Sunwood AI Labs article: https://note.com/sunwood_ai_labs/n/n0e0a896b6d8c
