"use client";

import SideBar from "@/Components/SidBar/SideBar";
import { ClipboardList, Database, Save, Sliders, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { base_usrl } from "@/lib/base-url";

// Only the profile name is saved on the server (PATCH /users/me); other preferences live in localStorage.

const API_URL = base_usrl;

type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: string;
};

type UserSettings = {
  temperature: number; // 0 - 2 (same range as the backend)
  repeats: number; // 1 - 5
  swapOrder: boolean;
  defaultJudgeModelId: string; // "" = none
  defaultRubricId: string; // "" = none
  monthlySpendingCap: number; // USD, 0 = no limit
};

const DEFAULT_SETTINGS: UserSettings = {
  temperature: 0.2,
  repeats: 3,
  swapOrder: false,
  defaultJudgeModelId: "",
  defaultRubricId: "",
  monthlySpendingCap: 0,
};

const settingsKey = (userId: string) => `tokenlens:settings:${userId}`;

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return (
    localStorage.getItem("access_token") ||
    localStorage.getItem("token") ||
    sessionStorage.getItem("access_token") ||
    sessionStorage.getItem("token")
  );
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: authHeaders() });
  if (res.status === 401) throw new Error("Please log in again.");
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json();
}

const getCurrentUser = () => getJson<CurrentUser>("/auth/me");

/** Returns the saved settings, or null if this user never saved any. */
function loadSettings(userId: string): UserSettings | null {
  try {
    const raw = localStorage.getItem(settingsKey(userId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<UserSettings>;
    return {
      temperature: clamp(Number(p.temperature ?? DEFAULT_SETTINGS.temperature), 0, 2),
      repeats: Math.round(clamp(Number(p.repeats ?? DEFAULT_SETTINGS.repeats), 1, 5)),
      swapOrder: Boolean(p.swapOrder),
      defaultJudgeModelId: typeof p.defaultJudgeModelId === "string" ? p.defaultJudgeModelId : "",
      defaultRubricId: typeof p.defaultRubricId === "string" ? p.defaultRubricId : "",
      monthlySpendingCap: Math.max(0, Number(p.monthlySpendingCap ?? 0) || 0),
    };
  } catch {
    return null;
  }
}

function saveSettings(userId: string, settings: UserSettings): void {
  localStorage.setItem(settingsKey(userId), JSON.stringify(settings));
}

function clamp(n: number, min: number, max: number) {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

/** Sum of total_cost_usd of the user's runs created in the current calendar month (UTC). */
async function getMonthlySpend(): Promise<number> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  let total = 0;
  // Runs come newest first, so stop as soon as a page reaches a previous month.
  for (let page = 1; page <= 50; page++) {
    const data = await getJson<{
      items: { total_cost_usd: string | number; created_at: string }[];
      size: number;
      total: number;
    }>(`/runs?page=${page}&size=100`);
    let reachedOlder = false;
    for (const run of data.items) {
      const d = new Date(run.created_at);
      if (d.getUTCFullYear() === year && d.getUTCMonth() === month) {
        total += Number(run.total_cost_usd) || 0;
      } else {
        reachedOlder = true;
      }
    }
    if (reachedOlder || page * data.size >= data.total) break;
  }
  return total;
}

/** Same rule the New Run page uses: the worker needs complete criteria whose weights sum to 1. */
function isRubricUsable(rubric: { criteria?: unknown[] }): boolean {
  const criteria = rubric.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) return false;
  let total = 0;
  for (const c of criteria as Record<string, any>[]) {
    if (!c || typeof c !== "object") return false;
    if (typeof c.name !== "string" || !c.name.trim()) return false;
    if (typeof c.label !== "string" || !c.label.trim()) return false;
    if (typeof c.description !== "string") return false;
    const weight = Number(c.weight);
    if (c.weight == null || !Number.isFinite(weight) || weight <= 0) return false;
    const levels = c.level_descriptions;
    if (!levels || typeof levels !== "object") return false;
    if (Object.keys(levels).sort().join(",") !== "1,2,3,4,5") return false;
    total += weight;
  }
  return Math.abs(total - 1) < 1e-6;
}


const panelClass = "rounded-xl border border-[#1b2750] bg-[#0b132b] p-6 text-slate-200 shadow-lg";
const fieldClass =
  "w-full rounded-lg border border-[#223062] bg-[#091129] px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#4a5df0] focus:outline-none focus:ring-1 focus:ring-[#4a5df0] transition-colors disabled:opacity-60 disabled:cursor-not-allowed";
const labelClass = "mb-1.5 block text-xs font-medium text-slate-300";

type ApiModel = { id: string; display_name: string; provider: string; is_active: boolean };
type ApiRubric = { id: string; name: string; criteria?: unknown[] };
type Notice = { kind: "success" | "error"; text: string } | null;

function errorText(data: unknown, fallback: string) {
  const d = (data as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e: { msg?: string }) => e.msg).filter(Boolean).join(", ") || fallback;
  return fallback;
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const [user, setUser] = useState<CurrentUser | null>(null);
  const [models, setModels] = useState<ApiModel[]>([]);
  const [rubrics, setRubrics] = useState<ApiRubric[]>([]);
  const [monthSpend, setMonthSpend] = useState<number | null>(null);

  // Profile (stored on the backend)
  const [name, setName] = useState("");

  // Defaults for new runs (stored in the browser, applied by the New Run page)
  const [temperature, setTemperature] = useState(DEFAULT_SETTINGS.temperature);
  const [repeats, setRepeats] = useState(String(DEFAULT_SETTINGS.repeats));
  const [swapOrder, setSwapOrder] = useState(DEFAULT_SETTINGS.swapOrder);
  const [judgeModelId, setJudgeModelId] = useState("");
  const [rubricId, setRubricId] = useState("");
  const [monthlyCap, setMonthlyCap] = useState("0");

  useEffect(() => {
    let mounted = true;
    async function init() {
      try {
        const me = await getCurrentUser();
        const [modelsData, rubricsData] = await Promise.all([
          getJson<ApiModel[]>("/models"),
          getJson<{ items: ApiRubric[] }>("/rubrics?page=1&size=100"),
        ]);
        if (!mounted) return;

        setUser(me);
        setName(me.name);
        setModels(modelsData.filter((m) => m.is_active));
        setRubrics((rubricsData.items ?? []).filter(isRubricUsable));

        const saved = loadSettings(me.id);
        if (saved) {
          setTemperature(saved.temperature);
          setRepeats(String(saved.repeats));
          setSwapOrder(saved.swapOrder);
          setJudgeModelId(saved.defaultJudgeModelId);
          setRubricId(saved.defaultRubricId);
          setMonthlyCap(String(saved.monthlySpendingCap));
        } else {
          setRepeats(String(DEFAULT_SETTINGS.repeats));
        }

        // Spend is informational: don't fail the whole page if it can't load.
        getMonthlySpend()
          .then((v) => mounted && setMonthSpend(v))
          .catch(() => mounted && setMonthSpend(null));
      } catch (err) {
        if (mounted) setLoadError(err instanceof Error ? err.message : "Failed to load settings.");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    init();
    return () => {
      mounted = false;
    };
  }, []);

  // If a saved default no longer exists (deleted / deactivated), show it as "None".
  const judgeValue = models.some((m) => m.id === judgeModelId) ? judgeModelId : "";
  const rubricValue = rubrics.some((r) => r.id === rubricId) ? rubricId : "";

  const capNumber = Number(monthlyCap);
  const capValid = monthlyCap.trim() !== "" && Number.isFinite(capNumber) && capNumber >= 0;
  const spendPercent = useMemo(() => {
    if (monthSpend === null || !capValid || capNumber <= 0) return null;
    return Math.min(100, (monthSpend / capNumber) * 100);
  }, [monthSpend, capValid, capNumber]);

  const handleSaveProfile = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNotice({ kind: "error", text: "Name must not be blank." });
      return;
    }
    if (trimmed === user?.name) {
      setNotice({ kind: "success", text: "No changes to save." });
      return;
    }
    setSavingProfile(true);
    setNotice(null);
    try {
      const res = await fetch(`${API_URL}/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errorText(data, "Failed to update profile."));
      setUser(data as CurrentUser);
      setName((data as CurrentUser).name);
      setNotice({ kind: "success", text: "Profile updated successfully." });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Failed to update profile." });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSaveSettings = () => {
    if (!user) return;
    if (!capValid) {
      setNotice({ kind: "error", text: "Please enter a valid monthly spending cap (0 = no limit)." });
      return;
    }
    try {
      saveSettings(user.id, {
        temperature,
        repeats: Number(repeats),
        swapOrder,
        defaultJudgeModelId: judgeValue,
        defaultRubricId: rubricValue,
        monthlySpendingCap: capNumber,
      });
      setNotice({ kind: "success", text: "Settings saved. New runs will start with these defaults." });
    } catch {
      setNotice({ kind: "error", text: "Could not save settings in this browser." });
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060b1f] text-white">
        <p className="animate-pulse text-sm text-slate-400">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060b1f] text-slate-200 font-sans">
      <SideBar />

      <main className="min-w-0 px-4 pb-12 pt-20 sm:ml-64 sm:px-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Manage your account and default evaluation preferences.</p>
        </header>

        {loadError && (
          <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-400">
            {loadError}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className={`mb-6 rounded-lg border p-4 text-sm ${
              notice.kind === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-rose-500/30 bg-rose-500/10 text-rose-400"
            }`}
          >
            {notice.text}
          </div>
        )}

        {!loadError && (
          <>
            <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* 1. Profile */}
              <section className={panelClass}>
                <div className="mb-6 flex items-start gap-4">
                  <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 text-blue-400">
                    <User size={22} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white">Profile</h2>
                    <p className="text-xs text-slate-400">Update your personal information.</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className={labelClass}>Name</label>
                    <input
                      type="text"
                      value={name}
                      maxLength={120}
                      onChange={(e) => setName(e.target.value)}
                      className={fieldClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Email</label>
                    <input type="email" value={user?.email ?? ""} disabled className={fieldClass} />
                    <p className="mt-1.5 text-[11px] text-slate-500">Email cannot be changed.</p>
                  </div>
                  <div className="pt-2">
                    <button
                      onClick={handleSaveProfile}
                      disabled={savingProfile}
                      className="w-full rounded-lg bg-[#3347e0] py-2.5 text-sm font-medium text-white shadow-md transition-colors hover:bg-[#4256f0] disabled:opacity-50"
                    >
                      {savingProfile ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </div>
              </section>

              {/* 2. Run defaults */}
              <section className={panelClass}>
                <div className="mb-6 flex items-start gap-4">
                  <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 text-blue-400">
                    <Sliders size={22} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white">Run Defaults</h2>
                    <p className="text-xs text-slate-400">Pre-filled every time you open New Run.</p>
                  </div>
                </div>

                <div className="space-y-5">
                  <div>
                    <p className="text-sm text-slate-400">
                      Models use their provider&apos;s default temperature.
                    </p>
                  </div>

                  <div>
                    <label className={labelClass}>Repeats</label>
                    <select value={repeats} onChange={(e) => setRepeats(e.target.value)} className={fieldClass}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className={labelClass}>Default Judge Model</label>
                    <select value={judgeValue} onChange={(e) => setJudgeModelId(e.target.value)} className={fieldClass}>
                      <option value="">None (choose per run)</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name} ({m.provider})
                        </option>
                      ))}
                    </select>
                  </div>

                  <p className="text-[11px] text-slate-500">
                    Max output tokens is fixed by the evaluation worker and can&apos;t be changed per user.
                  </p>
                </div>
              </section>

              {/* 3. Evaluation preferences */}
              <section className={panelClass}>
                <div className="mb-6 flex items-start gap-4">
                  <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 text-blue-400">
                    <ClipboardList size={22} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white">Evaluation Preferences</h2>
                    <p className="text-xs text-slate-400">Configure how your runs are evaluated.</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className={labelClass}>Default scoring rubric</label>
                    <select value={rubricValue} onChange={(e) => setRubricId(e.target.value)} className={fieldClass}>
                      <option value="">None (choose per run)</option>
                      {rubrics.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <label className="flex cursor-pointer items-center gap-3 pt-2">
                    <input
                      type="checkbox"
                      checked={swapOrder}
                      onChange={(e) => setSwapOrder(e.target.checked)}
                      className="h-4 w-4 rounded border-[#223062] bg-[#091129] text-[#3347e0] focus:ring-[#4a5df0]"
                    />
                    <span className="text-sm text-slate-200">Swap answer order for judging</span>
                  </label>
                </div>
              </section>

              {/* 4. Usage & cost */}
              <section className={panelClass}>
                <div className="mb-6 flex items-start gap-4">
                  <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3 text-blue-400">
                    <Database size={22} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white">Usage &amp; Cost Controls</h2>
                    <p className="text-xs text-slate-400">New runs that would exceed this cap are blocked.</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className={labelClass}>Monthly spending cap (0 = no limit)</label>
                    <div className="relative">
                      <span className="absolute left-3.5 top-2.5 text-sm text-slate-400">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={monthlyCap}
                        onChange={(e) => setMonthlyCap(e.target.value)}
                        className={`${fieldClass} pl-8`}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 flex justify-between text-xs text-slate-400">
                      <span>Spent this month</span>
                      <span className="font-mono text-slate-200">
                        {monthSpend === null ? "—" : `$${monthSpend.toFixed(4)}`}
                      </span>
                    </div>
                    {spendPercent !== null && (
                      <div className="h-2 overflow-hidden rounded-full bg-[#091129]">
                        <div
                          className={`h-full ${spendPercent >= 100 ? "bg-rose-500" : spendPercent >= 80 ? "bg-amber-400" : "bg-[#3347e0]"}`}
                          style={{ width: `${spendPercent}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleSaveSettings}
                className="flex items-center gap-2 rounded-lg bg-[#3347e0] px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-950/50 transition-colors hover:bg-[#4256f0]"
              >
                <Save size={16} />
                Save Settings
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}