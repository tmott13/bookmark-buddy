/**
 * A hidden page the background worker opens when a new bookmark needs sorting.
 * It runs Gemma with WebLLM (WebGPU needs a page, not a service worker), answers, and gets closed after a few idle minutes.
 * It only ever uses a model that's already downloaded: it never starts a big download on its own.
 */
import * as webllm from "@mlc-ai/web-llm";
import { extensionAppConfig } from "../src/app/model-config";

declare const chrome: any;

let engine: webllm.MLCEngine | null = null;
let loaded = "";

async function classify(model: string, prompt: string): Promise<string> {
  if (!("gpu" in navigator)) throw new Error("no-webgpu");
  if (!engine || loaded !== model) {
    const appConfig = extensionAppConfig(webllm);
    if (!(await webllm.hasModelInCache(model, appConfig)))
      throw new Error("not-downloaded");
    await engine?.unload();
    engine = await webllm.CreateMLCEngine(
      model,
      { appConfig },
      { context_window_size: 2048, sliding_window_size: -1 },
    );
    loaded = model;
  }
  const r = await engine.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 40,
  });
  return r.choices[0]?.message?.content ?? "";
}

chrome.runtime.onMessage.addListener(
  (msg: any, _sender: unknown, reply: (r: unknown) => void) => {
    if (msg?.target !== "offscreen" || msg.type !== "classify") return;
    classify(msg.model, msg.prompt)
      .then((text) => reply({ text }))
      .catch((e) => reply({ error: String(e?.message ?? e) }));
    return true; // answer asynchronously
  },
);
