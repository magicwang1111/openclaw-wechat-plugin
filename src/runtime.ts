import type { PluginRuntime } from "openclaw/plugin-sdk";

let _runtime: PluginRuntime | undefined;

export function setSimpleWecomRuntime(runtime: PluginRuntime) {
  _runtime = runtime;
}

export function getSimpleWecomRuntime() {
  if (!_runtime) throw new Error("SimpleWeCom runtime not initialized");
  return _runtime;
}
