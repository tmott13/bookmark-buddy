/**
 * In the extension, Gemma's engine code (the small WebGPU .wasm "model library") ships inside the extension
 * instead of being downloaded, as the Chrome Web Store requires. Only the model weights (data) are downloaded.
 * On the website this returns undefined, so WebLLM uses its normal prebuilt config.
 */
declare const chrome: any;

const IDS = ["gemma-2-2b-it-q4f16_1-MLC", "gemma3-1b-it-q4f16_1-MLC"];

export function extensionAppConfig(webllm: { prebuiltAppConfig: any }): any {
  if (
    typeof chrome === "undefined" ||
    !chrome?.runtime?.getURL ||
    !chrome?.bookmarks
  )
    return undefined;
  const base = webllm.prebuiltAppConfig;
  if (!base?.model_list) return undefined;
  return {
    ...base,
    model_list: base.model_list
      .filter((m: any) => IDS.includes(m.model_id))
      .map((m: any) => ({
        ...m,
        model_lib: chrome.runtime.getURL(
          "lib/" + String(m.model_lib).split("/").pop(),
        ),
      })),
  };
}
