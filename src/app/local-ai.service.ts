import { Injectable, signal } from "@angular/core";
import type { MLCEngine } from "@mlc-ai/web-llm";
import { extensionAppConfig } from "./model-config";

/** iPhone/iPad can only fit the small model. */
export const IOS =
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export interface ModelChoice {
  id: string;
  label: string;
  size: string;
  note: string;
}

export const MODELS: ModelChoice[] = [
  {
    id: "gemma-2-2b-it-q4f16_1-MLC",
    label: "Gemma 2 · 2B",
    size: "~1.4 GB",
    note: "Better writing. Best on a laptop.",
  },
  {
    id: "gemma3-1b-it-q4f16_1-MLC",
    label: "Gemma 3 · 1B",
    size: "~700 MB",
    note: "Lighter and faster. Works on iPhone.",
  },
];

/** Room for a post excerpt plus the answer. WebLLM allows only one window setting, so sliding is off. */
const chatOpts = () => ({
  context_window_size: IOS ? 2048 : 4096,
  sliding_window_size: -1,
});
export const EXCERPT_CHARS = IOS ? 1200 : 2600;

// Crash guard: if the tab dies while Gemma loads (usually low memory), remember it and never auto-load again.
const LOADING = "bb.gemma.loading";
const OK = "bb.gemma.ok";
const flag = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

export type AiState =
  "unsupported" | "idle" | "downloading" | "loading" | "ready" | "error";

export interface GenOpts {
  maxTokens: number;
  temperature?: number;
  onToken?: (textSoFar: string) => void;
}

/**
 * Gemma runs entirely in the browser with WebLLM (WebGPU). After a one-time download it is cached,
 * so drafts never leave the device and it keeps working offline.
 */
@Injectable({ providedIn: "root" })
export class LocalAiService {
  readonly state = signal<AiState>(hasWebGpu() ? "idle" : "unsupported");
  readonly progress = signal(0);
  readonly status = signal("");
  readonly modelId = signal<string | null>(null);
  readonly crashed = signal(false);
  readonly busy = signal(false);

  private engine: MLCEngine | null = null;

  /** Models this device can run, best first. */
  choices(): ModelChoice[] {
    return IOS ? MODELS.filter((m) => m.id.startsWith("gemma3-1b")) : MODELS;
  }

  async loadIfCached() {
    if (this.state() !== "idle") return;
    if (flag.get(LOADING)) {
      flag.del(LOADING);
      flag.del(OK);
      this.crashed.set(true);
      this.state.set("error");
      this.status.set(
        "Gemma closed the page last time it loaded, most likely because the device ran short on memory.",
      );
      return;
    }
    const last = flag.get(OK);
    if (!last) return;
    try {
      const webllm = await import("@mlc-ai/web-llm");
      if (await webllm.hasModelInCache(last, extensionAppConfig(webllm)))
        await this.load(last);
    } catch {
      /* not cached, that's fine */
    }
  }

  async load(id: string) {
    if (
      this.state() === "unsupported" ||
      this.state() === "downloading" ||
      this.state() === "loading"
    )
      return;
    if (this.engine && this.modelId() === id) return;
    if (this.engine) {
      await this.engine.unload();
      this.engine = null;
    }
    this.crashed.set(false);
    flag.set(LOADING, String(Date.now()));
    try {
      const webllm = await import("@mlc-ai/web-llm");
      const appConfig = extensionAppConfig(webllm);
      const cached = await webllm.hasModelInCache(id, appConfig);
      this.state.set(cached ? "loading" : "downloading");
      this.progress.set(0);
      this.engine = await webllm.CreateMLCEngine(
        id,
        {
          appConfig,
          initProgressCallback: (r) => {
            this.progress.set(Math.round(r.progress * 100));
            this.status.set(r.text);
          },
        },
        chatOpts(),
      );
      this.modelId.set(id);
      flag.del(LOADING);
      flag.set(OK, id);
      this.state.set("ready");
    } catch (e) {
      console.warn("Gemma failed to load", id, e);
      flag.del(LOADING);
      this.engine = null;
      this.status.set(String((e as Error)?.message ?? e));
      this.state.set("error");
    }
  }

  /** One fresh, single-turn request. Gemma has no system role, so all rules go in the user message. */
  async generate(prompt: string, o: GenOpts): Promise<string> {
    if (!this.engine) throw new Error("Gemma is not loaded");
    this.busy.set(true);
    try {
      await this.engine.resetChat();
      const stream = await this.engine.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        temperature: o.temperature ?? 0.7,
        top_p: 0.9,
        max_tokens: o.maxTokens,
        repetition_penalty: 1.1,
        frequency_penalty: 0.4,
        stream: true,
      });
      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? "";
        o.onToken?.(text);
      }
      return text;
    } finally {
      this.busy.set(false);
    }
  }

  stop() {
    this.engine?.interruptGenerate();
  }

  async remove() {
    const webllm = await import("@mlc-ai/web-llm");
    await this.engine?.unload();
    this.engine = null;
    for (const m of MODELS)
      await webllm
        .deleteModelAllInfoInCache(m.id, extensionAppConfig(webllm))
        .catch(() => {});
    this.modelId.set(null);
    flag.del(OK);
    this.state.set("idle");
  }
}

function hasWebGpu() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}
