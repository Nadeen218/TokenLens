"use client";
import SideBar from "@/Components/SidBar/SideBar";
import { base_usrl } from "@/lib/base-url";
import {
  AlertCircle,
  Cpu,
  Database,
  ExternalLink,
  Loader2,
  Play,
  Users,
} from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";

interface AdminDashboardData {
  totalUsers: number;
  totalRuns: number;
  totalModels: number;
  totalDatasets: number;
  recentRuns: Array<{
    runId: string;
    id: string;
    name: string;
    dataset: string;
    status: string;
  }>;
  models: Array<{ model: string; status: string }>;
  users: Array<{ id: string; name: string; email: string; role: string; runs: number }>;
}

const API = base_usrl;

// Helper function to get auth headers from localStorage/sessionStorage
const authHeaders = (): HeadersInit => {
  const token =
    localStorage.getItem("token") ||
    localStorage.getItem("access_token") ||
    sessionStorage.getItem("token") ||
    sessionStorage.getItem("access_token");

  return token ? { Authorization: `Bearer ` + token } : {};
};

// Fetches a list from any response shape (array or { items, total })
async function fetchList(path: string) {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!res.ok) return { list: [] as any[], total: 0 };
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const total = typeof data?.total === "number" ? data.total : list.length;
  return { list, total };
}
type HealthState = { api: boolean; database: boolean; redis: boolean };

async function fetchHealth(): Promise<HealthState> {
  try {
    const res = await fetch(`${API}/health`);
    const data = await res.json().catch(() => null);
    return {
      api: res.ok,
      database: data?.checks?.database === "ok",
      redis: data?.checks?.redis === "ok",
    };
  } catch {
    return { api: false, database: false, redis: false };
  }
}
// Admin Dashboard Component
function AdminDashboardContent() {
  const [dashboardData, setDashboardData] = useState<AdminDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState("");
  const [health, setHealth] = useState<HealthState | null>(null);
  const panel = "rounded-xl border border-[#1b2750] bg-[#0b132b] p-5 shadow-lg transition-all";

  // Fetch dashboard data from the backend API
  useEffect(() => {
    async function fetchDashboardData() {
      setLoading(true);
      setApiError("");
      try {
        const [models, datasets, users, runs, healthData] = await Promise.all([
          fetchList("/models"),
          fetchList("/datasets?page=1&size=100"),
          fetchList("/users?page=1&size=100"),
          fetchList("/runs?page=1&size=100"),
          fetchHealth(),
        ]);
        setHealth(healthData);

        const runsByUser: Record<string, number> = {};
        runs.list.forEach((r: any) => {
          if (r.user_id) runsByUser[r.user_id] = (runsByUser[r.user_id] || 0) + 1;
        });

        setDashboardData({
          totalUsers: users.total,
          totalRuns: runs.total,
          totalModels: models.total,
          totalDatasets: datasets.total,
          recentRuns: runs.list.slice(0, 5).map((r: any) => ({
            runId: r.id,
            id: `#${String(r.id).slice(0, 4)}`,
            name: r.name,
            dataset: r.dataset_name ?? r.dataset?.name ?? "—",
            status: String(r.status ?? "").toLowerCase(),
          })),
          models: models.list.map((m: any) => ({
            model: m.display_name || m.model_name,
            status: m.is_active ? "Active" : "Inactive",
          })),
          users: users.list.map((u: any) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            runs: runsByUser[u.id] ?? 0,
          })),
        });
      } catch (err) {
        setApiError(err instanceof Error ? err.message : "Could not load admin dashboard data.");
      } finally {
        setLoading(false);
      }
    }

    fetchDashboardData();
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060b1f] text-white">
        <div className="flex items-center gap-3">
          <Loader2 className="animate-spin text-blue-400" />
          <p className="text-sm text-slate-400">Loading Admin Dashboard from backend...</p>
        </div>
      </div>
    );
  }

  if (apiError || !dashboardData) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#060b1f] text-white">
        <div className={`${panel} max-w-md text-center p-6`}>
          <AlertCircle className="mx-auto text-red-400 mb-2" size={32} />
          <h2 className="text-lg font-semibold text-white">Failed to load Dashboard</h2>
          <p className="mt-2 text-sm text-slate-400">{apiError || "No data available."}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-[#3347e0] px-4 py-2 text-sm font-medium text-white hover:bg-[#4256f0]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060b1f] text-slate-200">
      <SideBar />

      <main className="min-w-0 px-4 pb-8 pt-6 sm:ml-64 sm:px-8">
        {/* Welcome Section */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Welcome back, Admin!</h1>
            <p className="text-xs text-slate-400 mt-1">
              Live platform overview connected to database.
            </p>
          </div>
        </div>

        {/* Top 4 KPI Metrics Cards */}
        <div className="mb-6 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <div
            onClick={() =>
              document.getElementById("users-table")?.scrollIntoView({ behavior: "smooth" })
            }
            className={`${panel} hover:border-blue-500/50 cursor-pointer`}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/20 text-blue-400">
              <Users size={20} />
            </div>
            <div className="mt-3">
              <span className="text-xs text-slate-400">Total Users</span>
              <div className="mt-1 text-2xl font-bold text-white">
                {dashboardData.totalUsers.toLocaleString()}
              </div>
            </div>
          </div>

          <Link href="/runhistory" className={`${panel} hover:border-blue-500/50 cursor-pointer`}>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
              <Play size={20} />
            </div>
            <div className="mt-3">
              <span className="text-xs text-slate-400">Total Runs</span>
              <div className="mt-1 text-2xl font-bold text-white">
                {dashboardData.totalRuns.toLocaleString()}
              </div>
            </div>
          </Link>

          <Link href="/models" className={`${panel} hover:border-blue-500/50 cursor-pointer`}>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/20 text-purple-400">
              <Cpu size={20} />
            </div>
            <div className="mt-3">
              <span className="text-xs text-slate-400">Total Models</span>
              <div className="mt-1 text-2xl font-bold text-white">
                {dashboardData.totalModels}
              </div>
            </div>
          </Link>

          <Link href="/datasets" className={`${panel} hover:border-blue-500/50 cursor-pointer`}>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/20 text-cyan-400">
              <Database size={20} />
            </div>
            <div className="mt-3">
              <span className="text-xs text-slate-400">Total Datasets</span>
              <div className="mt-1 text-2xl font-bold text-white">
                {dashboardData.totalDatasets}
              </div>
            </div>
          </Link>
        </div>

        {/* Middle Section: Users & System Status */}
        <div className="mb-6 grid gap-6 grid-cols-1 lg:grid-cols-3">
          <div id="users-table" className={`${panel} lg:col-span-2 flex flex-col`}>
            <div className="flex items-center gap-2 mb-4">
              <Users size={18} className="text-blue-400" />
              <h2 className="text-sm font-semibold text-white">Users & Their Runs</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#1b2750] text-slate-400">
                    <th className="pb-3 font-medium">Name</th>
                    <th className="pb-3 font-medium">Email</th>
                    <th className="pb-3 font-medium">Role</th>
                    <th className="pb-3 font-medium">Runs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#162248]">
                  {dashboardData.users.map((u) => (
                    <tr key={u.id}>
                      <td className="py-3 text-white font-medium">{u.name}</td>
                      <td className="py-3 text-slate-300">{u.email}</td>
                      <td className="py-3 text-slate-300">{u.role}</td>
                      <td className="py-3 font-semibold text-blue-400">{u.runs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

                    <div className={panel}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">System Status</h2>
            </div>
            <div className="space-y-4 text-xs">
              {[
                { label: "API Server", ok: health?.api },
                { label: "Database", ok: health?.database },
                { label: "Redis", ok: health?.redis },
              ].map((s) => (
                <div key={s.label} className="p-3 rounded-lg bg-[#060b1f] border border-[#1b2750]">
                  <span className={`font-semibold ${s.ok ? "text-emerald-400" : "text-rose-400"}`}>
                    ● {s.label}
                  </span>
                  <p className="text-slate-400 mt-1">{s.ok ? "Operational" : "Unavailable"}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Section: Recent Runs & Models */}
        <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
          <div className={`${panel} lg:col-span-2`}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">Recent Runs</h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#1b2750] text-slate-400">
                    <th className="pb-3 font-medium">Run ID</th>
                    <th className="pb-3 font-medium">Name</th>
                    <th className="pb-3 font-medium">Dataset</th>
                    <th className="pb-3 font-medium">Status</th>
                    <th className="pb-3 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#162248]">
                  {dashboardData.recentRuns.map((run, idx) => (
                    <tr key={idx} className="hover:bg-[#101c42]/40 transition-colors">
                      <td className="py-3 font-medium text-blue-400">{run.id}</td>
                      <td className="py-3 text-white font-medium">{run.name}</td>
                      <td className="py-3 text-slate-300">{run.dataset}</td>
                      <td className="py-3">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                          {run.status}
                        </span>
                      </td>
                      <td className="py-3">
                        {run.runId ? (
                          <Link
                            href={`/runresult/${run.runId}`}
                            className="inline-flex items-center gap-1 rounded border border-[#233266] bg-[#0c1636] px-2 py-1 text-[11px] text-blue-300 hover:bg-[#3347e0] hover:text-white transition-all"
                          >
                            Open <ExternalLink size={10} />
                          </Link>
                        ) : (
                          <span className="text-[11px] text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className={panel}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">Models Overview</h2>
              <Link href="/models" className="text-xs text-blue-400 hover:underline">View All →</Link>
            </div>

            <div className="space-y-4">
              {dashboardData.models.map((m, idx) => (
                <div key={idx} className="flex items-center justify-between border-b border-[#1b2750] pb-3 last:border-0">
                  <span className="text-xs font-semibold text-white">{m.model}</span>
                  <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">{m.status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// Main Admin Dashboard Page Component
export default function AdminDashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#060b1f] text-white">
          <p className="animate-pulse text-sm text-slate-400">Loading...</p>
        </div>
      }
    >
      <AdminDashboardContent />
    </Suspense>
  );
}