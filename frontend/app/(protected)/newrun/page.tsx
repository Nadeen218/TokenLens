"use client";
import SideBar from "@/Components/SidBar/SideBar";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Loader2, Play, Plus, RotateCcw, UploadCloud, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { base_usrl } from "@/lib/base-url";

type InputMode = "prompt" | "dataset";
const panel = "rounded-xl border border-[#1b2750] bg-[#0b132b] p-5";
const label = "mb-1.5 block text-sm font-medium text-slate-300";
const field = "w-full rounded-lg border border-[#223062] bg-[#091129] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#4a5df0] focus:outline-none focus:ring-1 focus:ring-[#4a5df0]";

const MAX_ROWS = 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const MIN_MODELS = 2;
const MAX_MODELS = 8;
const DRAFT_KEY = "tokenlens:new-run-draft";
const DEFAULT_AVG_ITEM_TOKENS = 150;
// The backend worker generates with a fixed output limit; it is not configurable per run.
const BACKEND_MAX_OUTPUT_TOKENS = 512;

const approxTokens = (text: string) => Math.ceil(text.length / 4);

type ModelInfo = {
  id: string;
  provider: string;
  displayName: string;
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  contextWindow?: number;
  isActive: boolean;
};

type Rubric = {
  id: string;
  name: string;
  description?: string;
  judge_instructions?: string;
  criteria?: any[];
  scale_min?: number;
  scale_max?: number;
};

/*
 * The evaluation worker builds every criterion with these required fields:
 * name, label, weight (all weights sum to 1), description and level_descriptions
 * covering exactly levels 1-5. A rubric missing any of them makes the run fail
 * before the first model call, so we never let the user start a run with one.
 */
const LEVEL_KEYS = ["1", "2", "3", "4", "5"];

function isRubricUsable(rubric: Rubric): boolean {
  const criteria = rubric.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) return false;
  let total = 0;
  for (const c of criteria) {
    if (!c || typeof c !== "object") return false;
    if (typeof c.name !== "string" || !c.name.trim()) return false;
    if (typeof c.label !== "string" || !c.label.trim()) return false;
    if (typeof c.description !== "string") return false;
    const weight = Number(c.weight);
    if (c.weight == null || !Number.isFinite(weight) || weight <= 0) return false;
    const levels = c.level_descriptions;
    if (!levels || typeof levels !== "object") return false;
    if (Object.keys(levels).sort().join(",") !== LEVEL_KEYS.join(",")) return false;
    total += weight;
  }
  return Math.abs(total - 1) < 1e-6;
}

// Weights are 0.5 + 0.5 on purpose: they sum to exactly 1 with no float rounding issue.
const DEFAULT_CRITERIA = [
  {
    name: "accuracy",
    label: "Accuracy",
    weight: 0.5,
    description: "Factual accuracy and correctness of the answer.",
    level_descriptions: {
      "1": "Mostly wrong or misleading.",
      "2": "Several factual errors.",
      "3": "Mostly correct with notable gaps.",
      "4": "Correct with minor omissions.",
      "5": "Fully correct and complete.",
    },
  },
  {
    name: "clarity",
    label: "Clarity",
    weight: 0.5,
    description: "Clarity, structure and formatting of the answer.",
    level_descriptions: {
      "1": "Confusing or unreadable.",
      "2": "Hard to follow.",
      "3": "Understandable but messy.",
      "4": "Clear with minor issues.",
      "5": "Very clear and well organized.",
    },
  },
];

type SavedDataset = { id: string; name: string; itemCount: number };
type ApiDataset = { id: string; name: string; item_count: number };

type ApiModel = {
  id: string;
  provider: string;
  display_name?: string;
  displayName?: string;
  input_price_per_mtok?: number | string | null;
  output_price_per_mtok?: number | string | null;
  inputPricePerMtok?: number | string | null;
  outputPricePerMtok?: number | string | null;
  context_window?: number;
  contextWindow?: number;
  is_active?: boolean;
  isActive?: boolean;
};

type DatasetItem = { input: string; expected_output?: string };

type UploadState = {
  fileName: string;
  file: File;
  rows: number;
  avgInputTokens: number;
  errors: string[];
  items: DatasetItem[];
};
// Parses a single line of CSV into an array of strings, handling quoted fields and escaped quotes.
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
// Validates the uploaded file, checking its type, size, and content structure, returning an UploadState object.
async function validateFile(file: File): Promise<UploadState> {
  const errors: string[] = [];
  const items: DatasetItem[] = [];
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (!["csv", "jsonl"].includes(extension ?? "")) errors.push("File must be CSV or JSONL.");
  if (file.size > MAX_BYTES) errors.push("File size must not exceed 5 MB.");

  if (errors.length > 0) {
    return { fileName: file.name, file, rows: 0, avgInputTokens: 0, errors, items: [] };
  }
  const content = await file.text();
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  const totalRows = extension === "csv" ? Math.max(0, lines.length - 1) : lines.length;
  if (lines.length === 0) errors.push("The file is empty.");
  if (extension === "jsonl") {
    lines.forEach((line, index) => {
      try {
        const obj = JSON.parse(line);
        if (typeof obj.input !== "string" || !obj.input.trim()) {
          errors.push(`Row ${index + 1}: input is required.`);
        } else {
          items.push({
            input: obj.input,
            expected_output: obj.expected_output == null ? undefined : String(obj.expected_output),
          });
        }
      } catch {
        errors.push(`Row ${index + 1}: Invalid JSON.`);
      }
    });
  }

  if (extension === "csv" && lines.length > 0) {
    const headers = parseCsvLine(lines[0]).map((h) => h.trim().replace(/^\uFEFF/, ""));
    const inputIndex = headers.indexOf("input");
    const expectedIndex = headers.indexOf("expected_output");

    if (inputIndex === -1) {
      errors.push('Missing required column "input".');
    } else {
      lines.slice(1).forEach((line, index) => {
        const cells = parseCsvLine(line);
        if (!cells[inputIndex]?.trim()) {
          errors.push(`Row ${index + 2}: input is empty.`);
        } else {
          items.push({
            input: cells[inputIndex],
            expected_output: expectedIndex >= 0 ? cells[expectedIndex] : undefined,
          });
        }
      });
    }
  }
  if (totalRows > MAX_ROWS) {
    errors.push(`Dataset cannot exceed ${MAX_ROWS} rows.`);
  }
  if (items.length === 0 && errors.length === 0) errors.push("Dataset contains no valid questions.");

  const averageCharacters =
    items.length > 0 ? items.reduce((sum, item) => sum + item.input.length, 0) / items.length : 0;
  return {
    fileName: file.name,
    file,
    rows: totalRows,
    avgInputTokens: Math.ceil(averageCharacters / 4),
    errors: errors.slice(0, 10),
    items,
  };
}

const API = base_usrl;

const authHeaders = (): HeadersInit => {
  const token =
    localStorage.getItem("access_token") ||
    localStorage.getItem("token") ||
    sessionStorage.getItem("access_token") ||
    sessionStorage.getItem("token");

  return token ? { Authorization: `Bearer ${token}` } : {};
};
// Fetches JSON data from the specified API path, handling authentication and errors.
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (response.status === 401) throw new Error("Please log in again.");
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

// ---- Settings helpers (inlined, no external file needed) ----
type CurrentUser = { id: string; name: string; email: string; role: string; created_at: string };
type SavedSettings = {
  temperature: number;
  repeats: number;
  swapOrder: boolean;
  defaultJudgeModelId: string;
  defaultRubricId: string;
  monthlySpendingCap: number;
};
function loadSettings(userId: string): SavedSettings | null {
  try {
    const raw = localStorage.getItem(`tokenlens:settings:${userId}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SavedSettings>;
    const clamp = (v: number, min: number, max: number) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min);
    return {
      temperature: clamp(Number(p.temperature ?? 0.2), 0, 2),
      repeats: Math.round(clamp(Number(p.repeats ?? 3), 1, 5)),
      swapOrder: Boolean(p.swapOrder),
      defaultJudgeModelId: typeof p.defaultJudgeModelId === "string" ? p.defaultJudgeModelId : "",
      defaultRubricId: typeof p.defaultRubricId === "string" ? p.defaultRubricId : "",
      monthlySpendingCap: Math.max(0, Number(p.monthlySpendingCap ?? 0) || 0),
    };
  } catch {
    return null;
  }
}
async function getMonthlySpend(): Promise<number> {
  const now = new Date();
  let total = 0;
  for (let page = 1; page <= 50; page++) {
    const data = await getJson<{
      items: { total_cost_usd: string | number; created_at: string }[];
      size: number;
      total: number;
    }>(`/runs?page=${page}&size=100`);
    let reachedOlder = false;
    for (const run of data.items) {
      const d = new Date(run.created_at);
      if (d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth()) {
        total += Number(run.total_cost_usd) || 0;
      } else {
        reachedOlder = true;
      }
    }
    if (reachedOlder || page * data.size >= data.total) break;
  }
  return total;
}

// Represents the structure of an API error response, which may contain a detail message or an array of messages.
type ApiError = { detail?: string | { msg: string }[] | { errors?: string[] } };
function errorMessage(data: ApiError | null, fallback: string) {
  const d = data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => e.msg).join(", ");
  if (d && "errors" in d && Array.isArray(d.errors)) return d.errors.join(", ");
  return fallback;
}
// Converts a value to a number, returning null if the value is null or undefined.
const toNum = (v: unknown) => (v == null ? null : Number(v));
// Normalizes an API model object into a ModelInfo structure, ensuring consistent field names and types.
function normalizeModel(model: ApiModel): ModelInfo {
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.display_name ?? model.displayName ?? model.id,
    inputPricePerMtok: toNum(model.input_price_per_mtok ?? model.inputPricePerMtok),
    outputPricePerMtok: toNum(model.output_price_per_mtok ?? model.outputPricePerMtok),
    contextWindow: model.context_window ?? model.contextWindow,
    isActive: model.is_active ?? model.isActive ?? true,
  };
}
// Main component for the New Run page, allowing users to configure and start a new evaluation run.
export default function NewRunPage() {
  const router = useRouter();
  const [mode, setMode] = useState<InputMode>("prompt");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runName, setRunName] = useState("");
  const [temperature, setTemperature] = useState(0.2);
  const maxTokens = BACKEND_MAX_OUTPUT_TOKENS;
  const [repeats, setRepeats] = useState(3);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [datasets, setDatasets] = useState<SavedDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [datasetId, setDatasetId] = useState("");
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  // Monthly spending cap from Settings (USD, 0 = no limit).
  const [spendingCap, setSpendingCap] = useState(0);

  // Modal states for adding a new Rubric
  const [isRubricModalOpen, setIsRubricModalOpen] = useState(false);
  const [newRubricName, setNewRubricName] = useState("");
  const [newRubricInstructions, setNewRubricInstructions] = useState("");
  const [addingRubric, setAddingRubric] = useState(false);

  const handleAddRubric = async () => {
    if (!newRubricName.trim()) {
      alert("Please enter a rubric name.");
      return;
    }
    setAddingRubric(true);
    try {
      const res = await fetch(`${API}/rubrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name: newRubricName.trim(),
          judge_instructions: newRubricInstructions.trim() || "Evaluate the model response accurately.",
          scale_min: 1,
          scale_max: 5,
          criteria: DEFAULT_CRITERIA,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorMessage(data, "Could not add rubric."));

      setIsRubricModalOpen(false);
      setNewRubricName("");
      setNewRubricInstructions("");

      const updatedRubrics = await getJson<{ items: Rubric[] }>("/rubrics?page=1&size=100");
      setRubrics(updatedRubrics.items || []);

      const createdId = data?.id || updatedRubrics.items?.[0]?.id;
      if (createdId) {
        setRubricId(createdId);
        const sel = updatedRubrics.items.find((r) => r.id === createdId);
        if (sel?.judge_instructions) {
          setJudgeInstructions(sel.judge_instructions);
        }
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create rubric.");
    } finally {
      setAddingRubric(false);
    }
  };
// Checks if the number of selected models is within the allowed range.
  const modelCountOk = selected.length >= MIN_MODELS && selected.length <= MAX_MODELS;
// Toggles the selection of a model by its ID, ensuring the selection does not exceed the maximum allowed models.
  const toggleModel = (id: string) => {
    setSelected((current) => {
      if (current.includes(id)) {
        return current.filter((item) => item !== id);
      }
      if (current.length >= MAX_MODELS) return current;
      return [...current, id];
    });
  };
// State variables for rubric selection, judge model selection, and related instructions.
  const [rubricId, setRubricId] = useState("");
  const [judgeModelId, setJudgeModelId] = useState("");
  const [judgeInstructions, setJudgeInstructions] = useState("");
  const [swapOrder, setSwapOrder] = useState(false);
// Selects a rubric by its ID, ensuring it is usable, and updates the judge instructions accordingly.
  const pickRubric = (id: string) => {
    const rubric = rubrics.find((r) => r.id === id);
    if (rubric && !isRubricUsable(rubric)) return;
    setRubricId(id);
    setJudgeInstructions(rubric?.judge_instructions ?? "");
  };
// State variables for error and success messages, as well as submission status.
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
// Handles the file selection, validating the file and updating the upload state or error messages accordingly.
  const handleFile = async (file?: File) => {
    if (!file) return;
    setError("");
    setSuccess("");
    setDatasetId("");
    try {
      setUpload(await validateFile(file));
    } catch {
      setUpload(null);
      setError("Could not read the selected file.");
    }
  };
// Removes the currently uploaded file, resetting the upload state and clearing the file input reference.
  const removeFile = () => {
    setUpload(null);
    if (fileRef.current) fileRef.current.value = "";
  };
// Loads models, rubrics, and datasets from the API when the component mounts, handling loading state and errors.
  useEffect(() => {
    let mounted = true;
    async function loadData() {
      setLoading(true);
      setApiError("");
      try {
        const [me, modelsData, rubricsData, datasetsData] = await Promise.all([
          getJson<CurrentUser>("/auth/me"),
          getJson<ApiModel[]>("/models"),
          getJson<{ items: Rubric[] }>("/rubrics?page=1&size=100"),
          getJson<{ items: ApiDataset[] }>("/datasets?page=1&size=100"),
        ]);
        if (!mounted) return;
        setModels(modelsData.map(normalizeModel));
        setRubrics(rubricsData.items || []);
        setDatasets(
          (datasetsData.items || []).map((d) => ({ id: d.id, name: d.name, itemCount: d.item_count }))
        );

        // Apply the defaults the user saved in Settings (if any).
        const saved = loadSettings(me.id);
        if (saved) {
          setTemperature(saved.temperature);
          setRepeats(saved.repeats);
          setSwapOrder(saved.swapOrder);
          setSpendingCap(saved.monthlySpendingCap);

          const judge = modelsData.map(normalizeModel).find((m) => m.id === saved.defaultJudgeModelId && m.isActive);
          if (judge) setJudgeModelId(judge.id);

          const rubric = (rubricsData.items || []).find((r) => r.id === saved.defaultRubricId);
          if (rubric && isRubricUsable(rubric)) {
            setRubricId(rubric.id);
            setJudgeInstructions(rubric.judge_instructions ?? "");
          }
        }
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
  const judgeModels = activeModels;
  const savedDataset = datasets.find((d) => d.id === datasetId);
  const selectedRubric = rubrics.find((r) => r.id === rubricId);
  const rubricOk = !!selectedRubric && isRubricUsable(selectedRubric);
  const hasInvalidRubrics = rubrics.some((r) => !isRubricUsable(r));
// Checks if there are any rubrics that are not usable, which may affect the ability to start a run.
  const hasInput =
    mode === "prompt"
      ? prompt.trim().length > 0
      : upload
        ? upload.errors.length === 0 && upload.rows > 0
        : !!savedDataset;
// Determines the number of items to be processed based on the input mode and available data.
  const itemCount =
    mode === "prompt"
      ? prompt.trim() ? 1 : 0
      : upload
        ? upload.errors.length === 0 ? upload.rows : 0
        : (savedDataset?.itemCount ?? 0);
// Determines if the user can start a new run based on various conditions, including loading state, errors, input availability, model selection, and submission status.
  const canRun =
    !loading &&
    !apiError &&
    hasInput &&
    modelCountOk &&
    rubricOk &&
    judgeModels.some((model) => model.id === judgeModelId) &&
    !selected.includes(judgeModelId) &&
    !submitting;
// Estimates the number of calls, judge calls, and comparison cost based on the selected models, input/output tokens, item count, repeats, and pricing information.
  const estimate = useMemo(() => {
    const selectedModels = activeModels.filter((m) => selected.includes(m.id));
    const inputTokens =
      mode === "prompt"
        ? approxTokens(systemPrompt + prompt)
        : upload?.avgInputTokens || DEFAULT_AVG_ITEM_TOKENS;
    const outputTokens = Math.round(maxTokens * 0.5);
    const calls = itemCount * selectedModels.length * repeats;
    const judgeCalls = calls * (swapOrder ? 2 : 1);
    const hasPrices =
      selectedModels.length > 0 &&
      selectedModels.every(
        (m) => m.inputPricePerMtok !== null && m.outputPricePerMtok !== null
      );

    const comparisonCost = hasPrices
      ? selectedModels.reduce(
        (sum, m) =>
          sum +
          itemCount *
          repeats *
          (
            (inputTokens * m.inputPricePerMtok! + outputTokens * m.outputPricePerMtok!) /
            1_000_000
          ),
        0
      )
      : null;
// Returns the estimated number of calls, judge calls, and comparison cost for the current configuration.
    return { calls, judgeCalls, comparisonCost };
  }, [activeModels, selected, mode, systemPrompt, prompt, upload, itemCount, maxTokens, repeats, swapOrder]);

  const startRun = async () => {
    if (!canRun) return;
    setSubmitting(true);
    setError("");
    setSuccess("");
// Validates the run name, selected models, and other parameters before starting a new run, handling errors and navigating to the new run page upon success.
    try {
      const name = runName.trim() || `Run ${new Date().toLocaleString()}`;
      if (selected.length < MIN_MODELS || selected.length > MAX_MODELS) {
        throw new Error("Please select between 2 and 8 models.");
      }
      if (new Set(selected).size !== selected.length) {
        throw new Error("Duplicate models are not allowed.");
      }
      if (selected.includes(judgeModelId)) {
        throw new Error("Value error, judge_model_id must not be one of model_ids.");
      }
      if (name.length > 150) {
        throw new Error("Run name cannot exceed 150 characters.");
      }
      if (spendingCap > 0) {
        const spent = await getMonthlySpend();
        const projected = spent + (estimate.comparisonCost ?? 0);
        if (projected > spendingCap) {
          throw new Error(
            `Monthly spending cap of $${spendingCap.toFixed(2)} would be exceeded ` +
              `(spent $${spent.toFixed(4)} + estimated $${(estimate.comparisonCost ?? 0).toFixed(4)}). ` +
              `Raise the cap in Settings to continue.`
          );
        }
      }
      let finalDatasetId = datasetId;

      if (mode === "prompt") {
        const res = await fetch(`${API}/datasets/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ name, input: prompt.trim(), description: systemPrompt.trim() }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(errorMessage(data, "Could not save the prompt."));
        finalDatasetId = data.id;
      } else if (upload) {
        const form = new FormData();
        form.append("name", name);
        if (systemPrompt.trim()) form.append("description", systemPrompt.trim());
        form.append("file", upload.file);
        const res = await fetch(`${API}/datasets/upload`, {
          method: "POST",
          headers: authHeaders(),
          body: form,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(errorMessage(data, "Could not upload the dataset."));
        finalDatasetId = data.id;
      }
// Creates a new run with the selected dataset, rubric, models, and run settings.
      const response = await fetch(`${API}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name,
          dataset_id: finalDatasetId,
          rubric_id: rubricId,
          model_ids: selected,
          judge_model_id: judgeModelId,
          repeats,
          swap_order: swapOrder,
        }),
      });
// Parses the response from the run creation request, checking for errors and ensuring an ID is returned. If successful, it removes the draft from local storage and navigates to the new run page.
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(data, `Could not start the run (HTTP ${response.status}).`));
      if (!data?.id) throw new Error("Run was created, but the response does not contain an ID.");
// Removes the saved draft from local storage and navigates to the newly created run's page.
      localStorage.removeItem(DRAFT_KEY);
      router.push(`/runresult/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  const saveDraft = () => {
    const draft = {
      mode, systemPrompt, prompt, runName, temperature, repeats,
      selected, rubricId, judgeModelId, judgeInstructions, swapOrder, datasetId,
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      setSuccess("Draft saved successfully.");
      setError("");
    } catch {
      setError("Could not save the draft.");
    }
  };
// Restores the saved draft from local storage, updating the component's state with the saved values. If no draft is found or an error occurs, it sets an appropriate error message.
  const restoreDraft = () => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (!saved) {
        setError("No saved draft found.");
        return;
      }
      const draft = JSON.parse(saved);
      setMode(draft.mode ?? "prompt");
      setSystemPrompt(draft.systemPrompt ?? "");
      setPrompt(draft.prompt ?? "");
      setRunName(draft.runName ?? "");
      setTemperature(draft.temperature ?? 0.2);
      setRepeats(draft.repeats ?? 3);
// Filters the selected models to ensure they are valid and active, updating the selected state accordingly.
      const validSelectedModels = Array.isArray(draft.selected)
        ? draft.selected.filter(
          (id: string) => typeof id === "string" && activeModels.some((model) => model.id === id)
        )
        : [];
      setSelected(validSelectedModels);
// Validates the rubric ID and judge model ID from the draft, ensuring they are usable and exist in the current state. Updates the corresponding state variables accordingly.
      setRubricId(rubrics.some((r) => r.id === draft.rubricId && isRubricUsable(r)) ? draft.rubricId : "");
      setJudgeModelId(judgeModels.some((m) => m.id === draft.judgeModelId) ? draft.judgeModelId : "");
      setJudgeInstructions(draft.judgeInstructions ?? "");
      setSwapOrder(draft.swapOrder ?? false);
      setDatasetId(draft.datasetId ?? "");
      setUpload(null);
      if (fileRef.current) fileRef.current.value = "";
      setSuccess("Draft restored successfully.");
      setError("");
    } catch {
      setError("Could not restore the saved draft.");
    }
  };

  return (
    // Main container with a dark background and light text, containing the sidebar and main content area.
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
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={restoreDraft}
              disabled={loading || !!apiError}
              className="flex items-center gap-2 rounded-lg border border-[#2a3a78] px-4 py-2.5 text-sm hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw size={15} /> Restore Draft
            </button>
            <button
              onClick={saveDraft}
              disabled={loading}
              className="rounded-lg border border-[#2a3a78] px-4 py-2.5 text-sm hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save as Draft
            </button>
            <div role="tablist" className="flex gap-2 text-sm">
              {(["prompt", "dataset"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg px-4 py-2 font-medium transition-colors ${
                    mode === m ? "bg-[#3347e0] text-white" : "border border-[#223062] bg-[#0c1530] text-slate-300 hover:bg-[#101c3f]"
                  }`}
                >
                  {m === "prompt" ? "Single Prompt" : "Upload Dataset"}
                </button>
              ))}
            </div>
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
              <AlertCircle size={17} /> {apiError}
            </p>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
          <section className={panel}>
            {mode === "prompt" && (
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
            )}

            {mode === "dataset" && (
              <div className="space-y-4">
                <label className={label}>Upload your dataset</label>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
                  onClick={() => fileRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center ${
                    dragging ? "border-blue-400 bg-blue-500/10" : "border-[#2a3a78] bg-[#091129]"
                  }`}
                >
                  <UploadCloud size={28} className="text-[#8ea0ff]" />
                  <span className="text-sm text-slate-300">Drop your CSV / JSONL file here or click to browse</span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,.jsonl"
                    className="hidden"
                    onChange={(e) => handleFile(e.target.files?.[0])}
                  />
                </div>

                {upload && (
                  <div className="rounded-lg border border-[#223062] bg-[#091129] p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileSpreadsheet size={18} className="text-blue-400" />
                        <span className="text-sm">{upload.fileName}</span>
                      </div>
                      <button onClick={removeFile} className="text-slate-400 hover:text-white"><X size={17} /></button>
                    </div>
                    {upload.errors.length === 0 ? (
                      <p className="mt-2 flex items-center gap-2 text-xs text-emerald-300">
                        <CheckCircle2 size={14} /> {upload.rows} questions ready
                      </p>
                    ) : (
                      upload.errors.map((msg, idx) => (
                        <p key={idx} className="mt-2 flex gap-2 text-xs text-red-300"><AlertCircle size={14} /> {msg}</p>
                      ))
                    )}
                  </div>
                )}

                <div>
                  <label htmlFor="saved-ds" className={label}>Or select a saved dataset</label>
                  <select
                    id="saved-ds"
                    value={datasetId}
                    disabled={!!upload}
                    onChange={(e) => { setDatasetId(e.target.value); if (e.target.value) removeFile(); }}
                    className={field}
                  >
                    <option value="">Select a dataset...</option>
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>{d.name} · {d.itemCount} items</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
{/*Conditionally renders the system prompt input field if the mode is "prompt" or if the mode is "dataset" and a file has been uploaded. This allows users to provide an optional system prompt for their evaluation run.*/}
            {(mode === "prompt" || (mode === "dataset" && !!upload)) && (
            <div className="mt-5">
              <label htmlFor="system-prompt" className={label}>System prompt (optional)</label>
              <textarea
                id="system-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
                placeholder="e.g. You are a helpful support agent…"
                className={field}
              />
            </div>
            )}
          </section>

          <section className={panel}>
            <h2 className="mb-4 font-semibold text-white">Run Settings</h2>
            <div className="space-y-5">
              <div>
                <label htmlFor="run-name" className={label}>Run Name</label>
                <input
                  id="run-name"
                  value={runName}
                  maxLength={150}
                  onChange={(e) => setRunName(e.target.value)}
                  placeholder="My comparison run"
                  className={field}
                />
              </div>
              <div>
                <p className="text-sm text-slate-400">
                  Models use their provider&apos;s default temperature.
                </p>
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

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <section className={panel}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold text-white">Comparison Models</h2>
              <span className="text-xs text-slate-400">{selected.length} / {MAX_MODELS} selected</span>
            </div>
            <p className="mb-4 text-xs text-slate-500">Select between 2 and 8 active models to compare.</p>
            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {activeModels.map((model) => {
                const checked = selected.includes(model.id);
                const isJudge = model.id === judgeModelId;
                const locked = isJudge || (!checked && selected.length >= MAX_MODELS);
                return (
                  <li key={model.id}>
                    <label className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${
                      checked ? "border-[#3347e0] bg-[#3347e0]/10" : "border-[#1b2750] bg-[#091129]"
                    } ${locked ? "cursor-not-allowed opacity-50" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={locked}
                        onChange={() => toggleModel(model.id)}
                        className="h-4 w-4 accent-[#4a5df0]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-white">{model.displayName}</span>
                        <span className="text-xs text-slate-500">{model.provider}{isJudge ? " · selected as judge" : ""}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className={panel}>
            <h2 className="mb-4 font-semibold text-white">Judge Configuration</h2>
            <div className="mb-5">
              <label htmlFor="judge-model" className={label}>Judge Model</label>
              <select
                id="judge-model"
                value={judgeModelId}
                onChange={(e) => setJudgeModelId(e.target.value)}
                className={field}
              >
                <option value="">Select a judge model...</option>
                {judgeModels.filter((m) => !selected.includes(m.id)).map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName} ({m.provider})</option>
                ))}
              </select>
            </div>

            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="rubric" className="block text-sm font-medium text-slate-300">Evaluation Rubric</label>
                  <button
                    type="button"
                    onClick={() => setIsRubricModalOpen(true)}
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    <Plus size={14} /> Add Rubric
                  </button>
                </div>
                <select
                  id="rubric"
                  value={rubricId}
                  onChange={(e) => pickRubric(e.target.value)}
                  className={field}
                >
                  <option value="">Select a rubric...</option>
                  {rubrics.map((r) => {
                    const usable = isRubricUsable(r);
                    return (
                      <option key={r.id} value={r.id} disabled={!usable}>
                        {r.name}{usable ? "" : " (invalid - cannot be used)"}
                      </option>
                    );
                  })}
                </select>
                {hasInvalidRubrics && (
                  <p className="mt-2 text-xs text-amber-300">
                    Some rubrics are missing fields the evaluation worker needs (label, weight, level descriptions),
                    so they are disabled. Use “Add Rubric” to create a valid one.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-5 text-sm text-slate-300">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={swapOrder}
                    onChange={(e) => setSwapOrder(e.target.checked)}
                    className="accent-[#4a5df0]"
                  />
                  Swap answer order
                </label>
              </div>
            </div>
          </section>
        </div>

        <section className={`${panel} mt-5`}>
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div>
              <p className="text-sm text-slate-400">
                {itemCount} items × {selected.length} models × {repeats} repeats
              </p>
              <p className="mt-1 text-xs text-slate-500 flex items-center gap-2">
                <span>{estimate.calls} model calls + {estimate.judgeCalls} judge calls</span>
                {estimate.comparisonCost !== null && (
                  <span className="font-semibold text-blue-400">
                    · Est. Cost: ${estimate.comparisonCost.toFixed(4)}
                  </span>
                )}
              </p>
            </div>

            <button
              onClick={startRun}
              disabled={!canRun}
              className="flex items-center gap-2 rounded-lg bg-[#3347e0] px-7 py-2.5 text-sm font-medium text-white hover:bg-[#4256f0] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              {submitting ? "Starting..." : "Run Evaluation"}
            </button>
          </div>

          {success && <p className="mt-4 flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 size={16} /> {success}</p>}
          {error && <p role="alert" className="mt-4 flex items-center gap-2 text-sm text-red-300"><AlertCircle size={16} /> {error}</p>}
        </section>

        {/* Add Rubric modal */}
        {isRubricModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className={`${panel} w-full max-w-md bg-[#0b132b] border-[#2a3a78] space-y-4 shadow-xl`}>
              <div className="flex items-center justify-between border-b border-[#1b2750] pb-3">
                <h3 className="text-lg font-semibold text-white">Add New Rubric</h3>
                <button onClick={() => setIsRubricModalOpen(false)} className="text-slate-400 hover:text-white"><X size={20} /></button>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Rubric Name *</label>
                <input
                  type="text"
                  placeholder="e.g. Helpfulness & Accuracy"
                  value={newRubricName}
                  onChange={(e) => setNewRubricName(e.target.value)}
                  className={field}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Judge Instructions</label>
                <textarea
                  rows={3}
                  placeholder="Instructions sent to judge model..."
                  value={newRubricInstructions}
                  onChange={(e) => setNewRubricInstructions(e.target.value)}
                  className={field}
                />
              </div>

              <p className="text-xs text-slate-500">
                The rubric is scored 1–5 on two criteria, Accuracy and Clarity, weighted equally.
              </p>

              <div className="flex justify-end gap-3 pt-3 border-t border-[#1b2750]">
                <button
                  onClick={() => setIsRubricModalOpen(false)}
                  className="rounded-lg border border-[#2a3a78] px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddRubric}
                  disabled={addingRubric}
                  className="flex items-center gap-2 rounded-lg bg-[#3347e0] px-5 py-2 text-sm font-medium text-white hover:bg-[#4256f0] disabled:opacity-50"
                >
                  {addingRubric && <Loader2 size={14} className="animate-spin" />}
                  Save Rubric
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}