"use client";
import SideBar from "@/Components/SidBar/SideBar";
import { AlertCircle, CheckCircle2, FileSpreadsheet, Loader2, UploadCloud, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
type InputMode = "prompt" | "dataset"; // Define the available input modes
const panel = "rounded-xl border border-[#1b2750] bg-[#0c1530] p-5";
const label = "mb-1.5 block text-sm font-medium text-slate-300";
const field = "w-full rounded-lg border border-[#223062] bg-[#091129] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#4a5df0] focus:outline-none focus:ring-1 focus:ring-[#4a5df0]";
// Define the maximum allowed dataset rows and file size
const MAX_ROWS = 1000;
const MAX_BYTES = 5 * 1024 * 1024;
// Define the minimum and maximum number of models that can be selected for a run
const MIN_MODELS = 2;
const MAX_MODELS = 8;

/*Types and Interfaces*/
type ModelInfo = {
  id: string;
  provider: string;
  displayName: string;
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  contextWindow?: number;
  isActive: boolean;
  isJudgeEligible: boolean;
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
  is_judge_eligible?: boolean;
  isJudgeEligible?: boolean;
};

type DatasetItem = { input: string; expected_output?: string };

type UploadState = {
  fileName: string;
  rows: number;
  avgInputTokens: number;
  errors: string[];
  items: DatasetItem[];
};
/* CSV Parsing*/
// Parse a CSV line into separate cells while handling quoted values
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
/*Dataset Validation*/
// Read a CSV or JSONL file and validate its format and contents
// Check required fields, file size, and maximum number of rows
async function validateFile(file: File): Promise<UploadState> {
  const errors: string[] = [];
  const items: DatasetItem[] = [];
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (!["csv", "jsonl"].includes(extension ?? "")) errors.push("File must be CSV or JSONL.");
  if (file.size > MAX_BYTES) errors.push("File size must not exceed 5 MB.");

  if (errors.length > 0) {
    return { fileName: file.name, rows: 0, avgInputTokens: 0, errors, items: [] };
  }
  // Read the file contents and remove empty lines
  const content = await file.text();
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
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
  // Check the maximum row limit and ensure that valid data exists
  if (items.length > MAX_ROWS) errors.push(`Dataset cannot exceed ${MAX_ROWS} rows.`);
  if (items.length === 0 && errors.length === 0) errors.push("Dataset contains no valid questions.");

  const averageCharacters =
    items.length > 0 ? items.reduce((sum, item) => sum + item.input.length, 0) / items.length : 0;
  // Return the validation results, including file information, errors, and parsed items
  return {
    fileName: file.name,
    rows: items.length,
    avgInputTokens: Math.ceil(averageCharacters / 4),
    errors: errors.slice(0, 10),
    items,
  };
}

/*API Configuration*/
// Get the backend API base URL from environment variables
// Use /api as the default URL if no environment variable is configured
const API = process.env.NEXT_PUBLIC_API_URL ?? "/api";

// Send a GET request to the API and return the response as JSON
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: "include" });
  if (!response.ok) throw new Error(`Failed to load ${path}`); // Throw an error if the API request fails
  return response.json();
}

/*API Data Normalization*/
// Convert API model data into the standardized format used by the frontend
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
    isJudgeEligible:
      model.is_judge_eligible ??
      model.isJudgeEligible ??
      false,
  };
}
/*Main Component*/
export default function NewRunPage() {
  // Store the currently selected input mode
  const [mode, setMode] = useState<InputMode>("prompt");
  // Store the user's prompt and optional system prompt
  const [systemPrompt, setSystemPrompt] = useState("");
  const [prompt, setPrompt] = useState("");
  // Store the run name and execution settings
  const [runName, setRunName] = useState("");
  const [temperature, setTemperature] = useState(0.2);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [repeats, setRepeats] = useState(3);
  // Store models, rubrics, and saved datasets retrieved from the backend API
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [datasets, setDatasets] = useState<SavedDataset[]>([]);
  // Manage API loading state and errors
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState("");
  // Create a reference to the hidden file input element
  const fileRef = useRef<HTMLInputElement>(null);
  // Store the uploaded file information and validation results
  const [upload, setUpload] = useState<UploadState | null>(null);
  // Store the ID of the selected saved dataset
  const [datasetId, setDatasetId] = useState("");
  // Track whether the user is dragging a file over the upload area
  const [dragging, setDragging] = useState(false);
  // Store the IDs of the models selected for comparison
  const [selected, setSelected] = useState<string[]>([]);

  // Check whether the selected model count is within the allowed range (2–8)
  const modelCountOk =
    selected.length >= MIN_MODELS && selected.length <= MAX_MODELS;

  // Toggle a model's selection while enforcing the maximum limit
  const toggleModel = (id: string) => {
    setSelected((current) => {
      // Remove the model if it is already selected
      if (current.includes(id)) {
        return current.filter((item) => item !== id);
      }

      // Prevent selecting more than the maximum allowed models
      if (current.length >= MAX_MODELS) return current;

      // Add the newly selected model
      return [...current, id];
    });
  };
  // Store the selected evaluation rubric and Judge model
  const [rubricId, setRubricId] = useState("");
  const [judgeModelId, setJudgeModelId] = useState("");

  // Store additional instructions for the Judge
  const [judgeInstructions, setJudgeInstructions] = useState("");

  // Control whether model names are hidden during evaluation
  const [hideNames, setHideNames] = useState(true);

  // Control whether answer order is swapped during evaluation
  const [swapOrder, setSwapOrder] = useState(false);

  // Select a rubric and automatically load its description as Judge instructions
  const pickRubric = (id: string) => {
    setRubricId(id);
    const rubric = rubrics.find((r) => r.id === id);
    setJudgeInstructions(rubric?.description ?? "");
  };
  // Store success and error messages related to file upload
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Handle file selection and validation
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
  // Remove the uploaded file and reset the input field
  const removeFile = () => {
    setUpload(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  useEffect(() => {
    let mounted = true;
    // Load models, rubrics, and datasets from the API when the component mounts
    async function loadData() {
      setLoading(true);
      setApiError("");
      try { // Send three API requests in parallel
        const [modelsData, rubricsData, datasetsData] = await Promise.all([
          getJson<ApiModel[]>("/models?active=true"),
          getJson<Rubric[]>("/rubrics"),
          getJson<SavedDataset[]>("/datasets"),
        ]);
        // Ensure the component is still mounted before updating its state
        if (!mounted) return;
        setModels(modelsData.map(normalizeModel));// Store the retrieved data and normalize the model objects
        setRubrics(rubricsData);
        setDatasets(datasetsData);
      } catch (err) {
        if (!mounted) return;
        setApiError(err instanceof Error ? err.message : "Could not load project data.");
      } finally {
        if (mounted) setLoading(false);// Stop the loading indicator after the requests finish
      }
    }
    // Start loading the page data
    loadData();
    return () => { // Prevent state updates if the component unmounts before requests finish
      mounted = false;
    };
  }, []);

  /*Derived Data*/
  // Filter and return only active models for model selection
  const activeModels = useMemo(() => models.filter((m) => m.isActive), [models]);
  // Get only active models that are approved for Judge evaluation.
  const judgeModels = models.filter(
    (model) => model.isActive && model.isJudgeEligible
  );
  /*ui*/
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
        {/* Display a loading indicator while retrieving data from the API */}
        {loading && (
          <div className={`${panel} mb-5 flex items-center gap-3`}>
            <Loader2 className="animate-spin text-blue-400" />
            <span className="text-sm">Loading models and project data...</span>
          </div>
        )}
        {/* Display an error message if loading data from the API fails */}
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
          {/* Section for entering a prompt, uploading a dataset, and configuring the system prompt */}
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
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    handleFile(e.dataTransfer.files[0]);
                  }}
                  onClick={() => fileRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fileRef.current?.click();
                    }
                  }}
                  className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center ${dragging ? "border-blue-400 bg-blue-500/10" : "border-[#2a3a78] bg-[#091129]"
                    }`}
                >
                  <UploadCloud size={28} className="text-[#8ea0ff]" />
                  <span className="text-sm text-slate-300">Drop your CSV / JSONL file here or click to browse</span>
                  <span className="text-xs text-slate-500">
                    Required: input · Optional: expected_output
                    <br />
                    Maximum 1,000 rows · 5 MB
                  </span>
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
                      <button
                        onClick={removeFile}
                        aria-label="Remove file"
                        className="text-slate-400 hover:text-white"
                      >
                        <X size={17} />
                      </button>
                    </div>

                    {upload.errors.length === 0 ? (
                      <p className="mt-2 flex items-center gap-2 text-xs text-emerald-300">
                        <CheckCircle2 size={14} />
                        {upload.rows} questions ready
                      </p>
                    ) : (
                      upload.errors.map((message, index) => (
                        <p key={index} className="mt-2 flex gap-2 text-xs text-red-300">
                          <AlertCircle size={14} />
                          {message}
                        </p>
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
                    onChange={(e) => setDatasetId(e.target.value)}
                    className={field}
                  >
                    <option value="">Select a dataset...</option>
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.itemCount} items
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

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
        {/* Row 2: model selection  +  judge configuration */}
        {/* Section for selecting models to compare and displaying the number of selected models */}
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <section className={panel}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-semibold text-white">Comparison Models</h2>
              <span className="text-xs text-slate-400">
                {selected.length} / {MAX_MODELS} selected
              </span>
            </div>
            <p className="mb-4 text-xs text-slate-500">Select between 2 and 8 active models to compare.</p>

            {activeModels.length === 0 ? (
              <p className="rounded-lg bg-[#091129] p-4 text-sm text-slate-400">
                No active models are currently available.
              </p>
            ) : (
              <ul className="max-h-80 space-y-2 overflow-y-auto">
                {activeModels.map((model) => {
                  const checked = selected.includes(model.id);
                  const locked = !checked && selected.length >= MAX_MODELS;
                  return (
                    <li key={model.id}>
                      <label
                        className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${checked ? "border-[#3347e0] bg-[#3347e0]/10" : "border-[#1b2750] bg-[#091129]"
                          } ${locked ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked}
                          onChange={() => toggleModel(model.id)}
                          className="h-4 w-4 accent-[#4a5df0]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-white">{model.displayName}</span>
                          <span className="text-xs text-slate-500">{model.provider}</span>
                        </span>
                        <span className="text-right text-xs text-slate-400">
                          {model.inputPricePerMtok !== null && model.outputPricePerMtok !== null
                            ? `$${model.inputPricePerMtok} / $${model.outputPricePerMtok}`
                            : "Pricing unavailable"}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {!modelCountOk && (
              <p className="mt-3 text-xs text-amber-300">Please select between 2 and 8 models.</p>
            )}
          </section>
          {/* Row 2: judge configuration */}
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
                {judgeModels.map((m) => ( // Only show models that are eligible to be used as a Judge
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.provider})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor="rubric" className={label}>Evaluation Rubric</label>
                <select
                  id="rubric"
                  value={rubricId}
                  onChange={(e) => pickRubric(e.target.value)}
                  className={field}
                >
                  <option value="">Select a rubric...</option>
                  {rubrics.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="judge-instructions" className={label}>Judge Instructions</label>
                <textarea
                  id="judge-instructions"
                  value={judgeInstructions}
                  onChange={(e) => setJudgeInstructions(e.target.value)}
                  rows={4}
                  placeholder="Define the criteria used to evaluate model responses..."
                  className={field}
                />
              </div>

              <div className="flex flex-wrap gap-5 text-sm text-slate-300">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={hideNames}
                    onChange={(e) => setHideNames(e.target.checked)}
                    className="accent-[#4a5df0]"
                  />
                  Hide model names
                </label>
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
      </main>
    </div>
  );
}