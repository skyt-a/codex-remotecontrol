import { getLanUrls, getRuntimeConfig } from "./config.mjs";
import { CodexBridge } from "./codexBridge.mjs";
import { createRemoteControlServer } from "./app.mjs";

const config = getRuntimeConfig();
const bridge = new CodexBridge({ ...config, version: "0.1.0" });
const server = createRemoteControlServer({ bridge, config });

server.listen(config.port, config.host, async () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : config.port;
  const urls = getLanUrls(actualPort, config.token);

  console.log("Codex RemoteControl is running.");
  for (const url of urls) {
    console.log(`  ${url}`);
  }

  try {
    await bridge.start();
  } catch (error) {
    console.error(`Codex app-server is not ready yet: ${error.message || error}`);
    console.error("The web UI will keep retrying when API calls are made.");
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  server.close();
  await bridge.stop();
  process.exit(0);
}
