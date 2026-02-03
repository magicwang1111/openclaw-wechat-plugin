import type { openclawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { simpleWecomPlugin } from "./src/channel.js";
import { setSimpleWecomRuntime } from "./src/runtime.js";

const plugin = {
  id: "simple-wecom",
  name: "Simple WeCom",
  description: "Generic HTTP-based WeCom integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: openclawPluginApi) {
    setSimpleWecomRuntime(api.runtime);
    api.registerChannel({ plugin: simpleWecomPlugin });
  },
};

export default plugin;