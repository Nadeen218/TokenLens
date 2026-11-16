"use client";
import SideBar from "@/Components/SidBar/SideBar";
import { base_usrl } from "@/lib/base-url";
import {
  Award,
  BarChart2,
  ChevronDown,
  Clock,
  Coins,
  Cpu,
  Database,
  DollarSign,
  Download,
  FileText,
  Layers,
  Play,
  Scale,
  Trophy,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { ReactNode, Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Types 

interface ModelResult {
  model: string;
  meanScore: number;
  stdDev: number;
  avgLatency: string;
  totalTokens: string;
  totalCost: string;
  failures: number;
  scoredCount: number;
  totalCalls: number;
  costVal: number;
  latencyVal: number;
}

interface DetailedItem {
  id: number;
  input: string;
  scores: {
    [key: string]: {
      score: number | null;
      latency: string;
      tokens: string;
      response: string;
      failed?: boolean;
    };
  };
  bestModel: string;
}

interface RunChanges {
  avgScore?: number;
  totalCost?: number;
  totalTokens?: number;
  duration?: number;
}

interface RunData {
  id: string;
  name: string;
  status: string;
  date: string;
  datasetName: string;
  modelCount: number;
  rubricName: string;
  rubricDescription?: string;
  avgScore?: number;
  totalCost: string;
  totalTokens: string;
  duration: string;
  errorMessage?: string;
  resultErrors: string[];
  resultCount: number;
  failedCount: number;
  changes?: RunChanges;
  modelsSummary?: ModelResult[];
  detailedResults?: DetailedItem[];
}

interface SelectedResponse {
  model: string;
  prompt: string;
  data: { score: number | null; latency: string; tokens: string; response: string; failed?: boolean };
}

//Constants

const API_URL = base_usrl;

const MODEL_COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#06b6d4"];

const TOOLTIP_STYLE = {
  backgroundColor: "#091129",
  borderColor: "#1b2750",
  borderRadius: "8px",
  color: "#fff",
};

const panel = "rounded-xl border border-[#1b2750] bg-[#0b132b] p-5 shadow-lg transition-all";

//Helpers

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number | null | undefined) {
  let s = String(value ?? "");
  // Stop Excel from running a text cell that starts with = + - @ as a formula.
  if (typeof value === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function safeFileName(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "run";
}

function buildCsv(run: RunData) {
  const models = (run.modelsSummary || []).map((m) => m.model);
  const header = [
    "#",
    "Input Prompt",
    ...models.flatMap((m) => [`${m} - Score`, `${m} - Latency`, `${m} - Tokens`, `${m} - Status`]),
    "Best Model",
  ];
  // Each row is: [item id, input prompt, model1 score, model1 latency, model1 tokens, model1 status, ..., best model]
  const rows = (run.detailedResults || []).map((item) => [
    item.id,
    item.input,
    ...models.flatMap((m) => {
      const r = item.scores[m];
      if (!r) return ["", "", "", "N/A"];
      const status = r.failed ? "Failed" : r.score === null ? "Not scored" : "OK";
      return [r.score ?? "", r.latency, r.tokens, status];
    }),
    item.bestModel === "—" ? "" : item.bestModel,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function EmptyState({ text, className = "py-20" }: { text: string; className?: string }) {
  return <p className={`${className} text-center text-sm text-slate-500`}>{text}</p>;
}

function ChangeBadge({ value, goodWhenUp }: { value?: number; goodWhenUp: boolean }) {
  if (value === undefined || value === null) return null;
  const up = value >= 0;
  const good = up === goodWhenUp;
  return (
    <span className={`mt-1 block text-[11px] font-medium ${good ? "text-emerald-400" : "text-rose-400"}`}>
      {up ? "↑" : "↓"} {up ? "+" : ""}
      {value}%
    </span>
  );
}

function StatCard({
  icon,
  iconClass,
  label,
  value,
  suffix,
  children,
}: {
  icon: ReactNode;
  iconClass: string;
  label: string;
  value: ReactNode;
  suffix?: string;
  children?: ReactNode;
}) {
  return (
    <div className={panel}>
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconClass}`}>{icon}</div>
      <div className="mt-3">
        <span className="text-xs text-slate-400">{label}</span>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-white">{value}</span>
          {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}
//Charts 
function QualityScatter({
  title,
  icon,
  models,
  xName,
  xUnit,
  getX,
  mounted,
}: {
  title: string;
  icon: ReactNode;
  models: ModelResult[];
  xName: string;
  xUnit: string;
  getX: (m: ModelResult) => number;
  mounted: boolean;
}) {
  return (
    <div className={panel}>
      <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
        {icon}
        {title}
      </h2>
      <div className="h-56 w-full min-w-0 pt-2">
        {models.length === 0 ? (
          <EmptyState text="No results available for this run." className="py-20" />
        ) : (
          mounted && (
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1b2750" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={xName}
                  unit={xUnit}
                  stroke="#64748b"
                  fontSize={11}
                  domain={[(min: number) => Math.max(0, min * 0.9), (max: number) => max * 1.1]}
                  tickFormatter={(v: number) => String(Math.round(v * 1000) / 1000)}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="Quality"
                  stroke="#64748b"
                  fontSize={11}
                  domain={[
                    (min: number) => Math.max(0, Math.floor(min - 5)),
                    (max: number) => Math.min(100, Math.ceil(max + 5)),
                  ]}
                />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} contentStyle={TOOLTIP_STYLE} />
                {models.map((m, i) => (
                  <Scatter
                    key={m.model}
                    name={m.model}
                    data={[{ x: Number(getX(m)) || 0, y: Number(m.meanScore) || 0 }]}
                    fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          )
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-4 text-xs text-slate-400">
        {models.map((m, i) => (
          <span key={m.model} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: MODEL_COLORS[i % MODEL_COLORS.length] }}
            />
            {m.model}
          </span>
        ))}
      </div>
    </div>
  );
}

// Backend shapes + aggregation

type ApiRun = {
  id: string;
  name: string;
  dataset_id: string;
  rubric_id: string;
  status: string;
  total_cost_usd: string | number;
  created_at: string;
  finished_at: string | null;
  model_ids: string[];
  // The backend may expose the failure reason under one of these names.
  error_message?: string | null;
  error?: string | null;
  failure_reason?: string | null;
};
// The backend returns a list of results for each model call, with the following shape.
type ApiResult = {
  item_id: string;
  question_text: string;
  position: number;
  model_id: string;
  model_display_name: string;
  repeat_index: number;
  output_text: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost_usd: string | number;
  status: string;
  error_message: string | null;
  judgments: { score: string | number }[];
};
// The backend returns the dataset and rubric with the following shapes.
type ApiDataset = { name: string };
type ApiRubric = { name: string; criteria?: { name?: string }[]; scale_min: number; scale_max: number };

const authHeaders = (): HeadersInit => {
  const token =
    localStorage.getItem("access_token") ||
    localStorage.getItem("token") ||
    sessionStorage.getItem("access_token") ||
    sessionStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};
// Fetch a JSON resource from the backend API, throwing an error if the response is not OK.
async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: authHeaders(), signal });
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "Unauthorized. Please log in again."
        : res.status === 404
          ? "Run not found."
          : `Failed to load ${path} (status ${res.status}).`
    );
  }
  return res.json();
}
// Fetch all results for a run, handling pagination. The backend returns results in pages of up to 200 items.
async function fetchAllResults(runId: string, signal: AbortSignal): Promise<ApiResult[]> {
  const size = 200;
  const all: ApiResult[] = [];
  for (let page = 1; page <= 100; page++) {
    const data = await apiGet<{ items: ApiResult[]; total: number }>(
      `/runs/${runId}/results?page=${page}&size=${size}`,
      signal
    );
    all.push(...data.items);
    if (all.length >= data.total || data.items.length === 0) break;
  }
  return all;
}
// Math helpers
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdDev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
const fmtUsd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtSeconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const fmtDuration = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

function buildRunData(run: ApiRun, results: ApiResult[], dataset: ApiDataset | null, rubric: ApiRubric | null): RunData {
  const min = rubric?.scale_min ?? 1;
  const max = rubric?.scale_max ?? 5;
  // The backend stores judge scores on the rubric scale (e.g. 1-5); the UI shows 0-100.
  const toPercent = (score: number) => (max > min ? ((score - min) / (max - min)) * 100 : score);
  // A judgment with score below the scale minimum means the judge failed (stored as 0): ignore it.
  const resultScore = (r: ApiResult): number | null => {
    const values = r.judgments.map((j) => Number(j.score)).filter((v) => Number.isFinite(v) && v >= min);
    return values.length ? toPercent(mean(values)) : null;
  };
  // Group results by model, in the order of the run's model_ids, then any extra models that were not in the run.
  const byModel = new Map<string, ApiResult[]>();
  for (const r of results) {
    if (!byModel.has(r.model_id)) byModel.set(r.model_id, []);
    byModel.get(r.model_id)!.push(r);
  }
  const orderedModelIds = [
    ...run.model_ids.filter((id) => byModel.has(id)),
    ...[...byModel.keys()].filter((id) => !run.model_ids.includes(id)),
  ];
  // Aggregate results for each model.
  const modelsSummary: ModelResult[] = orderedModelIds.map((modelId) => {
    const rs = byModel.get(modelId)!;
    const scores = rs.map(resultScore).filter((v): v is number => v !== null);
    const okResults = rs.filter((r) => r.status === "ok");
    const cost = rs.reduce((a, r) => a + Number(r.cost_usd), 0);
    const tokens = rs.reduce((a, r) => a + r.input_tokens + r.output_tokens, 0);
    const avgLatencyMs = mean(okResults.map((r) => r.latency_ms));
    return {
      model: rs[0].model_display_name,
      meanScore: round(mean(scores)),
      stdDev: round(stdDev(scores)),
      avgLatency: fmtSeconds(avgLatencyMs),
      totalTokens: fmtTokens(tokens),
      totalCost: fmtUsd(cost),
      failures: rs.filter((r) => r.status !== "ok").length,
      scoredCount: scores.length,
      totalCalls: rs.length,
      costVal: round(cost, 6),
      latencyVal: round(avgLatencyMs / 1000, 2),
    };
  });
  // Group results by item, in the order of their position in the dataset.
  const byItem = new Map<string, ApiResult[]>();
  for (const r of results) {
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    byItem.get(r.item_id)!.push(r);
  }
  const items = [...byItem.values()].sort((a, b) => a[0].position - b[0].position);

  const detailedResults: DetailedItem[] = items.map((rs, index) => {
    const scores: DetailedItem["scores"] = {};
    for (const modelId of orderedModelIds) {
      const mine = rs.filter((r) => r.model_id === modelId);
      if (mine.length === 0) continue;
      const name = mine[0].model_display_name;
      const scored = mine.map(resultScore).filter((v): v is number => v !== null);
      const score = scored.length ? round(mean(scored)) : null;
      const first = [...mine].sort((a, b) => a.repeat_index - b.repeat_index)[0];
      scores[name] = {
        score,
        latency: fmtSeconds(mean(mine.map((r) => r.latency_ms))),
        tokens: String(mine.reduce((a, r) => a + r.input_tokens + r.output_tokens, 0)),
        response: first.status === "ok" ? first.output_text : `Failed: ${first.error_message ?? "unknown error"}`,
        failed: mine.every((r) => r.status !== "ok"),
      };
    }
    const scoreValues = Object.values(scores)
      .map((s) => s.score)
      .filter((v): v is number => v !== null);
    const best = scoreValues.length ? Math.max(...scoreValues) : null;
    const winners =
      best === null
        ? []
        : Object.entries(scores)
          .filter(([, s]) => s.score === best)
          .map(([name]) => name);
    const bestModel = winners.length ? winners.join(" / ") : "—";
    return { id: index + 1, input: rs[0].question_text, scores, bestModel };
  });

  const allScores = results.map(resultScore).filter((v): v is number => v !== null);
  const sumCost = results.reduce((a, r) => a + Number(r.cost_usd), 0);
  const runCost = Number(run.total_cost_usd) || sumCost;
  const totalTokens = results.reduce((a, r) => a + r.input_tokens + r.output_tokens, 0);
  const created = new Date(run.created_at).getTime();
  const finished = run.finished_at ? new Date(run.finished_at).getTime() : null;
  const criteria = (rubric?.criteria ?? []).map((c) => c.name).filter(Boolean);
  const isActive = run.status === "queued" || run.status === "running";

  const resultErrors = [
    ...new Set(
      results
        .filter((r) => r.status !== "ok" && r.error_message)
        .map((r) => String(r.error_message))
    ),
  ].slice(0, 5);

  return {
    id: run.id,
    name: run.name,
    status: run.status,
    date: new Date(run.created_at).toLocaleString(),
    datasetName: dataset?.name ?? "—",
    modelCount: run.model_ids.length,
    rubricName: rubric?.name ?? "—",
    rubricDescription: rubric
      ? `${criteria.length ? `Criteria: ${criteria.join(", ")}. ` : ""}Judge scale ${min}–${max}, shown here as 0–100.`
      : undefined,
    avgScore: allScores.length ? round(mean(allScores)) : 0,
    totalCost: fmtUsd(runCost),
    totalTokens: fmtTokens(totalTokens),
    duration: finished !== null ? fmtDuration(finished - created) : isActive ? "In progress" : "—",
    errorMessage: run.error_message ?? run.error ?? run.failure_reason ?? undefined,
    resultErrors,
    resultCount: results.length,
    failedCount: results.filter((r) => r.status !== "ok").length,
    modelsSummary,
    detailedResults,
  };
}

//Page Component

function RunResultsContent({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const runId = resolvedParams.id;

  const [runData, setRunData] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const [showModelsDropdown, setShowModelsDropdown] = useState(false);
  const [showRubricDropdown, setShowRubricDropdown] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const modelsRef = useRef<HTMLDivElement>(null);
  const rubricRef = useRef<HTMLDivElement>(null);
  const downloadRef = useRef<HTMLDivElement>(null);

  const [activeTab, setActiveTab] = useState<"Score" | "Cost" | "Latency">("Score");
  const [selectedResponse, setSelectedResponse] = useState<SelectedResponse | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function fetchRunDetails(first: boolean) {
      if (first) {
        setLoading(true);
        setError(null);
      }
      let nextPoll = false;
      try {
        const run = await apiGet<ApiRun>(`/runs/${runId}`, controller.signal);
        const [results, dataset, rubric] = await Promise.all([
          fetchAllResults(runId, controller.signal),
          apiGet<ApiDataset>(`/datasets/${run.dataset_id}`, controller.signal).catch(() => null),
          apiGet<ApiRubric>(`/rubrics/${run.rubric_id}`, controller.signal).catch(() => null),
        ]);
        if (controller.signal.aborted) return;
        setRunData(buildRunData(run, results, dataset, rubric));
        setError(null);
        nextPoll = run.status === "queued" || run.status === "running";
      } catch (err) {
        if (controller.signal.aborted) return;
        if (first) setError(err instanceof Error ? err.message : "Something went wrong.");
        else nextPoll = true; // transient failure while polling: try again
      } finally {
        if (!controller.signal.aborted && first) setLoading(false);
      }
      if (nextPoll && !controller.signal.aborted) {
        timer = setTimeout(() => fetchRunDetails(false), 3000);
      }
    }
    // Fetch run details on mount, and poll every few seconds if the run is still active.
    fetchRunDetails(true);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (modelsRef.current && !modelsRef.current.contains(target)) setShowModelsDropdown(false);
      if (rubricRef.current && !rubricRef.current.contains(target)) setShowRubricDropdown(false);
      if (downloadRef.current && !downloadRef.current.contains(target)) setShowDownloadMenu(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);
  // Close dropdowns and modals when pressing Escape.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSelectedResponse(null);
        setShowModelsDropdown(false);
        setShowRubricDropdown(false);
        setShowDownloadMenu(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const modelsSummary = useMemo(() => runData?.modelsSummary || [], [runData]);
  const detailedResults = useMemo(() => runData?.detailedResults || [], [runData]);

  const chartData = useMemo(() => {
    return modelsSummary.map((m) => ({
      name: m.model,
      value: Number(activeTab === "Score" ? m.meanScore : activeTab === "Cost" ? m.costVal : m.latencyVal) || 0,
    }));
  }, [modelsSummary, activeTab]);

  const avgScore = useMemo(() => {
    if (!runData) return 0;
    if (modelsSummary.length === 0) return runData.avgScore ?? 0;
    const sum = modelsSummary.reduce((acc, m) => acc + m.meanScore, 0);
    return Math.round((sum / modelsSummary.length) * 10) / 10;
  }, [runData, modelsSummary]);

  const handleDownload = (format: "csv" | "json") => {
    if (!runData) return;
    const base = `${safeFileName(runData.name)}-results`;
    if (format === "csv") {
      // The BOM makes Excel read the file as UTF-8, otherwise "—", Arabic text, etc. show up garbled.
      downloadFile("\uFEFF" + buildCsv(runData), `${base}.csv`, "text/csv;charset=utf-8;");
    } else {
      downloadFile(JSON.stringify(runData, null, 2), `${base}.json`, "application/json");
    }
    setShowDownloadMenu(false);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060b1f] text-white">
        <p className="animate-pulse text-sm text-slate-400">Loading dynamic results dashboard...</p>
      </div>
    );
  }

  if (error || !runData) {
    return (
      <div className="min-h-screen bg-[#060b1f] text-slate-200">
        <SideBar />
        <main className="flex min-h-screen items-center justify-center px-4 sm:ml-64">
          <div className={`${panel} max-w-md text-center`}>
            <h1 className="text-lg font-semibold text-white">Couldn&apos;t load this run</h1>
            <p className="mt-2 text-sm text-slate-400">{error ?? "No data available."}</p>
            <div className="mt-5 flex justify-center gap-3">
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg border border-[#233266] bg-[#0c1636] px-4 py-2 text-sm text-slate-200 hover:bg-[#12204c] transition-all"
              >
                Retry
              </button>
              <Link
                href="/newrun"
                className="rounded-lg bg-[#3347e0] px-4 py-2 text-sm font-medium text-white hover:bg-[#4256f0] transition-all"
              >
                New Run
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }
  // Determine if the run is still active (queued or running) or has failed (failed or cancelled).
  const isActive = runData.status === "queued" || runData.status === "running";
  const isFailed = runData.status === "failed" || runData.status === "cancelled";
  const noResults = modelsSummary.length === 0;

  return (
    <div className="min-h-screen bg-[#060b1f] text-slate-200">
      <SideBar />

      <main className="min-w-0 px-4 pb-8 pt-20 sm:ml-64 sm:px-8">
        {isActive && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            This run is {runData.status}. Results update automatically every few seconds.
          </div>
        )}
        {isFailed && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            <p>
              This run {runData.status}.{" "}
              {noResults ? "No results were saved for it." : "Showing any partial results."}
            </p>
            {runData.errorMessage && (
              <p className="mt-1 text-xs text-rose-200/90">Reason: {runData.errorMessage}</p>
            )}
            {noResults && !runData.errorMessage && (
              <p className="mt-1 text-xs text-rose-200/70">
                The backend did not return a failure reason. Check the worker logs and the model API keys.
              </p>
            )}
          </div>
        )}
        {runData.failedCount > 0 && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            <p>
              {runData.failedCount} of {runData.resultCount} model calls failed, so those results have no tokens,
              cost or score.
            </p>
            {runData.resultErrors.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-rose-200/90">
                {runData.resultErrors.map((msg, i) => (
                  <li key={i} className="break-words">{msg}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {/* Header with title and download button */}
        <div className="relative z-30 mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Run Results</h1>
            <p className="text-xs text-slate-400 mt-1">Detailed analysis of your evaluation run</p>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative z-30" ref={downloadRef}>
              <button
                onClick={() => setShowDownloadMenu((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={showDownloadMenu}
                className="flex items-center gap-2 rounded-lg border border-[#233266] bg-[#0c1636] px-4 py-2 text-sm text-slate-200 hover:bg-[#12204c] active:scale-95 transition-all"
              >
                <Download size={15} />
                Download Results
                <ChevronDown size={14} className={`transition-transform ${showDownloadMenu ? "rotate-180" : ""}`} />
              </button>

              {showDownloadMenu && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-2 w-44 rounded-lg border border-[#1b2750] bg-[#091129] p-1 shadow-xl text-sm"
                >
                  <button
                    role="menuitem"
                    onClick={() => handleDownload("csv")}
                    className="w-full rounded px-3 py-2 text-left text-slate-200 hover:bg-[#12204c]"
                  >
                    Download CSV
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => handleDownload("json")}
                    className="w-full rounded px-3 py-2 text-left text-slate-200 hover:bg-[#12204c]"
                  >
                    Download JSON
                  </button>
                </div>
              )}
            </div>
            <Link
              href="/newrun"
              className="flex items-center gap-2 rounded-lg bg-[#3347e0] px-4 py-2 text-sm font-medium text-white hover:bg-[#4256f0] active:scale-95 transition-all"
            >
              <Play size={15} />
              New Run
            </Link>
          </div>
        </div>
        {/* Run summary panels */}
        <div className="mb-6 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${panel} flex items-center gap-3 py-3`}>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/20 text-blue-400">
              <Play size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">Run:</span>
                <span className="font-semibold text-white text-sm">{runData.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium border ${runData.status === "completed"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : isFailed
                        ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                    }`}
                >
                  {runData.status}
                </span>
              </div>
              <span className="text-[11px] text-slate-500">{runData.date}</span>
            </div>
          </div>

          <div className={`${panel} flex items-center gap-3 py-3`}>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500/20 text-indigo-400">
              <Database size={18} />
            </div>
            <div>
              <span className="block text-xs text-slate-400">Dataset</span>
              <span className="font-semibold text-white text-sm">{runData.datasetName}</span>
            </div>
          </div>

          <div ref={modelsRef} className={`${panel} relative flex items-center gap-3 py-3`}>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/20 text-blue-400">
              <Layers size={18} />
            </div>
            <button
              type="button"
              aria-expanded={showModelsDropdown}
              className="flex flex-1 items-center justify-between text-left"
              onClick={() => setShowModelsDropdown((v) => !v)}
            >
              <div>
                <span className="block text-xs text-slate-400">Models</span>
                <span className="font-semibold text-white text-sm">{runData.modelCount} Models</span>
              </div>
              <ChevronDown
                size={16}
                className={`text-slate-400 transition-transform ${showModelsDropdown ? "rotate-180" : ""}`}
              />
            </button>
            {/* Models dropdown */}
            {showModelsDropdown && (
              <div className="absolute top-full left-0 mt-2 w-full z-20 rounded-lg border border-[#1b2750] bg-[#091129] p-2 shadow-xl">
                <span className="text-[10px] text-slate-500 px-2 uppercase tracking-wider font-semibold">
                  Evaluated Models
                </span>
                {modelsSummary.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-slate-500">No model results yet.</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-xs">
                    {modelsSummary.map((m) => (
                      <li
                        key={m.model}
                        className="flex items-center justify-between p-2 rounded hover:bg-[#12204c] text-white"
                      >
                        <span>{m.model}</span>
                        <span className="text-[10px] text-slate-400">Score: {m.meanScore}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          {/* Rubric panel */}
          <div ref={rubricRef} className={`${panel} relative flex items-center gap-3 py-3`}>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/20 text-blue-400">
              <Award size={18} />
            </div>
            <button
              type="button"
              aria-expanded={showRubricDropdown}
              className="flex flex-1 items-center justify-between text-left"
              onClick={() => setShowRubricDropdown((v) => !v)}
            >
              <div>
                <span className="block text-xs text-slate-400">Rubric</span>
                <span className="font-semibold text-white text-sm">{runData.rubricName}</span>
              </div>
              <ChevronDown
                size={16}
                className={`text-slate-400 transition-transform ${showRubricDropdown ? "rotate-180" : ""}`}
              />
            </button>

            {showRubricDropdown && (
              <div className="absolute top-full right-0 mt-2 w-64 z-20 rounded-lg border border-[#1b2750] bg-[#091129] p-3 shadow-xl text-xs">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold block mb-1">
                  Rubric Details
                </span>
                <p className="text-slate-300 leading-relaxed">
                  {runData.rubricDescription || "General Quality Rubric for overall accuracy."}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="mb-6 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<Trophy size={18} />}
            iconClass="bg-amber-500/10 text-amber-400"
            label="Average Score"
            value={avgScore}
            suffix="/ 100"
          >
            <ChangeBadge value={runData.changes?.avgScore} goodWhenUp />
          </StatCard>

          <StatCard
            icon={<Coins size={18} />}
            iconClass="bg-indigo-500/10 text-indigo-400"
            label="Total Cost"
            value={runData.totalCost}
          >
            <ChangeBadge value={runData.changes?.totalCost} goodWhenUp={false} />
          </StatCard>

          <StatCard
            icon={<Cpu size={18} />}
            iconClass="bg-blue-500/10 text-blue-400"
            label="Total Tokens"
            value={runData.totalTokens}
          >
            <ChangeBadge value={runData.changes?.totalTokens} goodWhenUp={false} />
          </StatCard>

          <StatCard
            icon={<Clock size={18} />}
            iconClass="bg-cyan-500/10 text-cyan-400"
            label="Run Duration"
            value={runData.duration}
          >
            <ChangeBadge value={runData.changes?.duration} goodWhenUp={false} />
          </StatCard>
        </div>

        <div className="mb-6 grid gap-6 grid-cols-1 lg:grid-cols-2">
          <div className={panel}>
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <BarChart2 size={18} className="text-blue-400" />
                <h2 className="text-sm font-semibold text-white">Results Overview</h2>
              </div>

              <div className="flex rounded-lg bg-[#060c21] p-1 border border-[#1b2750]">
                {(["Score", "Cost", "Latency"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${activeTab === tab ? "bg-[#3347e0] text-white" : "text-slate-400 hover:text-white"
                      }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            <div className="h-64 w-full min-w-0 pt-2">
              {chartData.length === 0 ? (
                <EmptyState text="No results available for this run." className="py-24" />
              ) : (
                mounted && (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1b2750" vertical={false} />
                      <XAxis dataKey="name" stroke="#64748b" fontSize={12} tickLine={false} />
                      <YAxis stroke="#64748b" fontSize={12} tickLine={false} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                      <Bar dataKey="value" fill="#3347e0" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )
              )}
            </div>
            {chartData.length > 0 && chartData.every((d) => d.value === 0) && (
              <p className="mt-2 text-center text-xs text-amber-300">
                All values are 0 for this metric. If calls failed, the errors are listed at the top of the page.
              </p>
            )}
          </div>
          {/* Model Comparison Table */}
          <div className={panel}>
            <div className="flex items-center gap-2 mb-4">
              <Scale size={18} className="text-indigo-400" />
              <h2 className="text-sm font-semibold text-white">Model Comparison</h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#1b2750] text-slate-400">
                    <th className="pb-3 font-medium">Model</th>
                    <th className="pb-3 text-center font-medium">Mean Score ↑</th>
                    <th className="pb-3 text-center font-medium">StdDev ↓</th>
                    <th className="pb-3 text-center font-medium">Avg Latency</th>
                    <th className="pb-3 text-center font-medium">Total Tokens</th>
                    <th className="pb-3 text-center font-medium">Total Cost</th>
                    <th className="pb-3 text-center font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#162248] text-slate-200">
                  {modelsSummary.map((m) => (
                    <tr key={m.model} className="hover:bg-[#101c42]/50 transition-colors">
                      <td className="py-3 font-medium text-white">{m.model}</td>
                      <td className="py-3 text-center font-bold text-emerald-400">
                        {m.scoredCount > 0 ? m.meanScore : "—"}
                      </td>
                      <td className="py-3 text-center text-slate-400">± {m.stdDev}</td>
                      <td className="py-3 text-center text-slate-300">{m.avgLatency}</td>
                      <td className="py-3 text-center text-slate-300">{m.totalTokens}</td>
                      <td className="py-3 text-center text-slate-300">{m.totalCost}</td>
                      <td className={`py-3 text-center ${m.failures > 0 ? "font-semibold text-rose-400" : "text-slate-400"}`}>
                        {m.failures}/{m.totalCalls}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {modelsSummary.length === 0 && <EmptyState text="No results available for this run." />}
            </div>
          </div>
        </div>

        <div className="mb-6 grid gap-6 grid-cols-1 lg:grid-cols-2">
          <QualityScatter
            title="Cost vs Quality"
            icon={<DollarSign size={16} className="text-blue-400" />}
            models={modelsSummary}
            xName="Cost"
            xUnit="$"
            getX={(m) => m.costVal}
            mounted={mounted}
          />
          <QualityScatter
            title="Latency vs Quality"
            icon={<Zap size={16} className="text-cyan-400" />}
            models={modelsSummary}
            xName="Latency"
            xUnit="s"
            getX={(m) => m.latencyVal}
            mounted={mounted}
          />
        </div>
        {/* Detailed Results Table */}
        <div className={panel}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <FileText size={18} className="text-blue-400" />
              <h2 className="text-sm font-semibold text-white">Detailed Results</h2>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#1b2750] text-slate-400">
                  <th className="pb-3 w-10">#</th>
                  <th className="pb-3 font-medium">Input Prompt</th>
                  {modelsSummary.map((m) => (
                    <th key={m.model} className="pb-3 font-medium">
                      {m.model}
                    </th>
                  ))}
                  <th className="pb-3 font-medium">Best Model</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#162248]">
                {detailedResults.map((item) => (
                  <tr key={item.id} className="hover:bg-[#101c42]/30">
                    <td className="py-4 text-slate-400 font-medium">{item.id}</td>
                    <td className="py-4 pr-4 text-slate-200">
                      <div className="max-w-xs truncate" title={item.input}>
                        {item.input}
                      </div>
                    </td>

                    {modelsSummary.map((m) => {
                      const resData = item.scores?.[m.model];
                      return (
                        <td key={m.model} className="py-4 pr-3">
                          {resData ? (
                            <div className="flex items-center gap-2">
                              {resData.failed ? (
                                <span className="rounded bg-rose-500/20 px-2 py-1 text-xs font-bold text-rose-400 border border-rose-500/30">
                                  Failed
                                </span>
                              ) : resData.score === null ? (
                                <span className="rounded bg-amber-500/20 px-2 py-1 text-xs font-bold text-amber-400 border border-amber-500/30">
                                  Not scored
                                </span>
                              ) : (
                                <span className="rounded bg-emerald-500/20 px-2 py-1 text-xs font-bold text-emerald-400 border border-emerald-500/30">
                                  {resData.score}/100
                                </span>
                              )}
                              <button
                                onClick={() =>
                                  setSelectedResponse({
                                    model: m.model,
                                    prompt: item.input,
                                    data: resData,
                                  })
                                }
                                className="rounded border border-[#223062] px-2 py-1 text-[11px] text-blue-300 hover:bg-[#3347e0] hover:text-white transition-all"
                              >
                                View
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-500">N/A</span>
                          )}
                        </td>
                      );
                    })}

                    <td className="py-4">
                      <div className="flex items-center gap-1 font-medium text-amber-400">
                        <Trophy size={14} />
                        {item.bestModel}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detailedResults.length === 0 && <EmptyState text="No results available for this run." className="py-12" />}
          </div>
        </div>
      </main>

      {selectedResponse && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setSelectedResponse(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="response-modal-title"
            className="w-full max-w-lg rounded-xl border border-[#1b2750] bg-[#0b132b] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#1b2750] pb-3">
              <h3 id="response-modal-title" className="font-semibold text-white">
                {selectedResponse.model} Response Details
              </h3>
              <button
                onClick={() => setSelectedResponse(null)}
                aria-label="Close"
                className="text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>
            {/* Prompt and model output details */}
            <div className="mt-4 space-y-3 text-xs">
              <div>
                <span className="text-slate-400 block font-medium mb-1">Prompt:</span>
                <p className="bg-[#060b1f] p-2.5 rounded border border-[#1b2750] text-slate-200">
                  {selectedResponse.prompt}
                </p>
              </div>

              <div>
                <span className="text-slate-400 block font-medium mb-1">Model Output:</span>
                <p className="bg-[#060b1f] p-2.5 rounded border border-[#1b2750] text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {selectedResponse.data.response}
                </p>
              </div>

              <div className="flex items-center gap-4 text-slate-400 pt-2 border-t border-[#1b2750]">
                <span>
                  Score:{" "}
                  <strong className="text-emerald-400">
                    {selectedResponse.data.score === null ? "—" : `${selectedResponse.data.score}/100`}
                  </strong>
                </span>
                <span>
                  Latency: <strong className="text-white">{selectedResponse.data.latency}</strong>
                </span>
                <span>
                  Tokens: <strong className="text-white">{selectedResponse.data.tokens}</strong>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
//Page Component 
export default function RunResultsPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#060b1f] text-white">
          <p className="animate-pulse text-sm text-slate-400">Loading run results...</p>
        </div>
      }
    >
      <RunResultsContent params={params} />
    </Suspense>
  );
}