"use client";
import SideBar from "@/Components/SidBar/SideBar";
import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
type InputMode = "prompt" | "dataset";
const panel = "rounded-xl border border-[#1b2750] bg-[#0c1530] p-5";
const label = "mb-1.5 block text-sm font-medium text-slate-300";
const field = "w-full rounded-lg border border-[#223062] bg-[#091129] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#4a5df0] focus:outline-none focus:ring-1 focus:ring-[#4a5df0]";
/*Types*/
type ModelInfo = {
  id: string;
  provider: string;
  displayName: string;
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  contextWindow?: number;
  isActive: boolean;
};

type Rubric = { id: string; name: string; description?: string };

type SavedDataset = { id: string; name: string; itemCount: number };

type ApiModel = {
  id: string;
  provider: string;
  display_name?: string;
  displayName?: string;
  input_price_per_mtok?: number | null;
  output_price_per_mtok?: number | null;
  inputPricePerMtok?: number | null;
  outputPricePerMtok?: number | null;
  context_window?: number;
  contextWindow?: number;
  is_active?: boolean;
  isActive?: boolean;
};

const API = process.env.NEXT_PUBLIC_API_URL ?? "/api";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

function normalizeModel(model: ApiModel): ModelInfo {
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.display_name ?? model.displayName ?? model.id,
    inputPricePerMtok:
      model.input_price_per_mtok ?? model.inputPricePerMtok ?? null,
    outputPricePerMtok:
      model.output_price_per_mtok ?? model.outputPricePerMtok ?? null,
    contextWindow: model.context_window ?? model.contextWindow,
    isActive: model.is_active ?? model.isActive ?? true,
  };
}
export default function NewRunPage() {
  const [mode, setMode] = useState<InputMode>("prompt");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runName, setRunName] = useState("");
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [repeats, setRepeats] = useState(3);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [datasets, setDatasets] = useState<SavedDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState("");

  useEffect(() => {
    let mounted = true;

    async function loadData() {
      setLoading(true);
      setApiError("");
      try {
        const [modelsData, rubricsData, datasetsData] = await Promise.all([
          getJson<ApiModel[]>("/models?active=true"),
          getJson<Rubric[]>("/rubrics"),
          getJson<SavedDataset[]>("/datasets"),
        ]);
        if (!mounted) return;
        setModels(modelsData.map(normalizeModel));
        setRubrics(rubricsData);
        setDatasets(datasetsData);
      } catch (err) {
        if (!mounted) return;
        setApiError(err instanceof Error ? err.message : "Could not load project data.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadData();
    return () => {
      mounted = false;
    };
  }, []);

  const activeModels = useMemo(() => models.filter((m) => m.isActive), [models]);
  return (
    <div className="min-h-screen bg-[#060b1f] text-slate-200">
      <SideBar />
      <main className="min-w-0 px-4 pb-8 pt-20 sm:ml-64 sm:px-8">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">New Run</h1>
            <p className="mt-1 text-sm text-slate-400">
              Configure your test, select models and run comparisons.
            </p>
          </div>
          {/* Mode selection buttons */}
          <div role="tablist" className="flex gap-2 text-sm">
            {(["prompt", "dataset"] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-lg px-4 py-2 font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6b7dff] ${mode === m
                  ? "bg-[#3347e0] text-white"
                  : "border border-[#223062] bg-[#0c1530] text-slate-300 hover:bg-[#101c3f]"
                  }`}
              >
                {m === "prompt" ? "Single Prompt" : "Upload Dataset"}
              </button>
            ))}
          </div>
        </header>
        {loading && (
          <div className={`${panel} mb-5 flex items-center gap-3`}>
            <Loader2 className="animate-spin text-blue-400" />
            <span className="text-sm">Loading models and project data...</span>
          </div>
        )}

        {apiError && (
          <div className="mb-5 rounded-xl border border-red-500/40 bg-red-500/10 p-4">
            <p className="flex items-center gap-2 text-sm text-red-300">
              <AlertCircle size={17} />
              {apiError}
            </p>
          </div>
        )}
        {/* Row 1: prompt / dataset  +  settings */}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
          <section className={panel}>
            {mode === "prompt" && (
              <div className="space-y-3">
                <div>
                  <label htmlFor="prompt" className={label}>Your prompt</label>
                  <textarea
                    id="prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={9}
                    placeholder="Enter your prompt here…"
                    className={field}
                  />
                  <p className="mt-1.5 text-right text-xs text-slate-500">{prompt.length} characters</p>
                </div>
                <div>
                  <label htmlFor="system-prompt" className={label}>System prompt (optional)</label>
                  <textarea
                    id="system-prompt"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={2}
                    placeholder="e.g. You are a helpful support agent…"
                    className={field}
                  />
                </div>
              </div>
            )}
          </section>
          {/* Row 1: settings */}
          <section className={panel}>
            <h2 className="mb-4 font-semibold text-white">Run Settings</h2>
            <div className="space-y-5">
              <div>
                <label htmlFor="run-name" className={label}>Run Name</label>
                <input
                  id="run-name"
                  value={runName}
                  onChange={(e) => setRunName(e.target.value)}
                  placeholder="My comparison run"
                  className={field}
                />
              </div>
              <div>
                <label htmlFor="temperature" className={label}>Temperature</label>
                <div className="flex items-center gap-3">
                  <input
                    id="temperature"
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={temperature}
                    onChange={(e) => setTemperature(Number(e.target.value))}
                    className="w-full accent-[#4a5df0]"
                  />
                  <span className="w-12 text-center text-sm">{temperature.toFixed(1)}</span>
                </div>
              </div>
              <div>
                <label htmlFor="max-tokens" className={label}>Max Output Tokens</label>
                <input
                  id="max-tokens"
                  type="number"
                  min={1}
                  max={32000}
                  value={maxTokens}
                  onChange={(e) =>
                    setMaxTokens(Math.min(32000, Math.max(1, Number(e.target.value) || 1)))
                  }
                  className={field}
                />
              </div>
              <div>
                <label htmlFor="repeats" className={label}>Repeats</label>
                <select
                  id="repeats"
                  value={repeats}
                  onChange={(e) => setRepeats(Number(e.target.value))}
                  className={field}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            </div>
          </section>
        </div>
        {/* Row 1: dataset */}
        {/* Row 2: model selection  +  judge configuration */}
      </main>
    </div>
  );
}