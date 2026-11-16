"use client";
import SideBar from "@/Components/SidBar/SideBar";
import StatCard from "@/Components/StatCard/StatCard";
import { base_usrl } from "@/lib/base-url";
import { AlertCircle, Cpu, Loader2, Plus, Search, Server, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const panel = "rounded-xl border border-[#1b2750] bg-[#0b132b] p-5";
const field = "w-full rounded-lg border border-[#223062] bg-[#091129] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#4a5df0] focus:outline-none focus:ring-1 focus:ring-[#4a5df0]";

type ModelItem = {
  id: string;
  provider: string;
  displayName: string;
  badge?: string;
  contextWindow: string;
  inputPricePerMtok: number;
  outputPricePerMtok: number;
  isActive: boolean;
};

const API = base_usrl;

const authHeaders = (): HeadersInit => {
  const token =
    localStorage.getItem("access_token") ||
    localStorage.getItem("token") ||
    sessionStorage.getItem("access_token") ||
    sessionStorage.getItem("token");

  return token ? { Authorization: `Bearer ${token}` } : {};
};
const PROVIDER_OPTIONS = [
  { label: "Azure", value: "Azure" },
  { label: "Google AI Studio", value: "gemini" },
];
export default function ModelsPage() {
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("All Providers");
  const [selectedStatus, setSelectedStatus] = useState("All Statuses");

  // State for admin privileges and modal visibility
  const [isAdmin, setIsAdmin] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newModel, setNewModel] = useState({
    provider: "",
    displayName: "",
    inputPrice: "",
    outputPrice: "",
    contextWindow: "128000",
  });

  // التحقق من صلاحية الـ Admin عند تحميل الصفحة
  useEffect(() => {
    const userRole =
      localStorage.getItem("role") || sessionStorage.getItem("role");
    if (userRole === "admin") {
      setIsAdmin(true);
    }
  }, []);

  // جلب النماذج من الباك إند عند تحميل الصفحة
  const fetchModels = async () => {
    setLoading(true);
    setApiError("");
    try {
      const res = await fetch(`${API}/models`, { headers: authHeaders() });
      if (res.status === 401) throw new Error("Please log in again.");
      if (!res.ok) throw new Error("Failed to load models from backend.");

      const data = await res.json();
      const formatted: ModelItem[] = data.map((m: any) => ({
        id: m.id,
        provider: m.provider ?? "Unknown",
        displayName: m.display_name ?? m.displayName ?? m.id,
        contextWindow: m.context_window ? `${m.context_window / 1000}K` : "128K",
        inputPricePerMtok: Number(m.input_price_per_mtok ?? m.inputPricePerMtok ?? 0),
        outputPricePerMtok: Number(m.output_price_per_mtok ?? m.outputPricePerMtok ?? 0),
        isActive: m.is_active ?? m.isActive ?? true,
      }));
      setModels(formatted);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Could not load models.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  // إضافة نموذج جديد وإرساله إلى الباك إند (للأدمن فقط)
  const handleAddModel = async () => {
    if (!isAdmin) {
      alert("Unauthorized: Only admins can add models.");
      return;
    }
    if (!newModel.provider || !newModel.displayName) {
      alert("Please fill in the provider and display name.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          model_name: newModel.displayName.toLowerCase().replace(/\s+/g, "-"),
          provider: newModel.provider,
          display_name: newModel.displayName,
          input_price_per_mtok: parseFloat(newModel.inputPrice) || 0,
          output_price_per_mtok: parseFloat(newModel.outputPrice) || 0,
          context_window: parseInt(newModel.contextWindow) || 128000,
          is_active: true,
        }),
      });

      if (!res.ok) throw new Error("Failed to add new model.");

      setIsModalOpen(false);
      setNewModel({ provider: "", displayName: "", inputPrice: "", outputPrice: "", contextWindow: "128000" });
      fetchModels(); // تحديث الجدول تلقائياً
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not add model.");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleModelStatus = async (id: string) => {
    const current = models.find((m) => m.id === id);
    if (!current) return;
    const next = !current.isActive;

    setModels((prev) => prev.map((m) => (m.id === id ? { ...m, isActive: next } : m)));

    try {
      const res = await fetch(`${API}/models/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) throw new Error("Failed to update model status.");
    } catch (err) {
      setModels((prev) => prev.map((m) => (m.id === id ? { ...m, isActive: !next } : m)));
      alert(err instanceof Error ? err.message : "Could not update model.");
    }
  };
  const providerList = useMemo(
    () => Array.from(new Set(models.map((m) => m.provider))).sort(),
    [models]
  );
  const filteredModels = useMemo(() => {
    return models.filter(m => {
      const matchesSearch = m.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.provider.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesProvider = selectedProvider === "All Providers" || m.provider === selectedProvider;
      const matchesStatus = selectedStatus === "All Statuses" ||
        (selectedStatus === "Active" && m.isActive) ||
        (selectedStatus === "Inactive" && !m.isActive);
      return matchesSearch && matchesProvider && matchesStatus;
    });
  }, [models, searchQuery, selectedProvider, selectedStatus]);

  const modelStats = [
    {
      id: "total-models",
      title: "Total Models",
      value: models.length,
      change: "Active & Inactive",
      changeType: "positive" as const,
      icon: Cpu,
    },
    {
      id: "active-models",
      title: "Active Models",
      value: models.filter(m => m.isActive).length,
      change: "Ready for runs",
      changeType: "positive" as const,
      icon: Server,
    },
  ];

  return (
    <div className="min-h-screen bg-[#060b1f] text-slate-200">
      <SideBar />
      <main className="min-w-0 px-4 pb-8 pt-20 sm:ml-64 sm:px-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">Models</h1>
            <p className="mt-1 text-sm text-slate-400">
              Manage model providers, available models, and token pricing from backend.
            </p>
          </div>

          {/* إظهار زر Add Model حصرياً للـ Admin */}
          {isAdmin && (
            <button
              onClick={() => setIsModalOpen(true)}
              className="flex items-center gap-2 rounded-lg bg-[#3347e0] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#4256f0] transition-colors"
            >
              <Plus size={16} />
              Add Model
            </button>
          )}
        </header>

        {loading && (
          <div className={`${panel} mb-5 flex items-center gap-3`}>
            <Loader2 className="animate-spin text-blue-400" />
            <span className="text-sm">Loading models from backend...</span>
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

        {/* شريط البحث والفلاتر */}
        <div className={`${panel} mb-6 flex flex-wrap items-center justify-between gap-4 py-4`}>
          <div className="relative flex-1 min-w-[280px]">
            <Search className="absolute left-3 top-3 text-slate-500" size={18} />
            <input
              type="text"
              placeholder="Search models..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`${field} pl-10`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              className="rounded-lg border border-[#223062] bg-[#091129] px-3 py-2.5 text-sm text-slate-300 focus:border-[#4a5df0] focus:outline-none"
            >
              <option value="All Providers">All Providers</option>
              {providerList.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="rounded-lg border border-[#223062] bg-[#091129] px-3 py-2.5 text-sm text-slate-300 focus:border-[#4a5df0] focus:outline-none"
            >
              <option value="All Statuses">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>
        </div>

        {/* جدول النماذج */}
        <section className={`${panel} mb-6 overflow-x-auto p-0`}>
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead>
              <tr className="border-b border-[#1b2750] text-xs font-medium text-slate-400 bg-[#091129]/50">
                <th className="py-3.5 px-4">Provider</th>
                <th className="py-3.5 px-4">Model Name</th>
                <th className="py-3.5 px-4">Context Window</th>
                <th className="py-3.5 px-4">Input / 1M Tokens</th>
                <th className="py-3.5 px-4">Output / 1M Tokens</th>
                <th className="py-3.5 px-4">Status</th>
                {isAdmin && <th className="py-3.5 px-4 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1b2750]/60 text-sm">
              {filteredModels.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="py-8 text-center text-slate-500">
                    {loading ? "Loading..." : "No models found."}
                  </td>
                </tr>
              ) : (
                filteredModels.map((model) => (
                  <tr key={model.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-3.5 px-4 font-medium text-white flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-blue-500"></span>
                      {model.provider}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className="text-white font-medium">{model.displayName}</span>
                    </td>
                    <td className="py-3.5 px-4 text-slate-300">{model.contextWindow}</td>
                    <td className="py-3.5 px-4 text-slate-300">${model.inputPricePerMtok.toFixed(2)}</td>
                    <td className="py-3.5 px-4 text-slate-300">${model.outputPricePerMtok.toFixed(2)}</td>
                    <td className="py-3.5 px-4">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border ${model.isActive
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : "border-red-500/30 bg-red-500/10 text-red-300"
                        }`}>
                        {model.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                   {isAdmin && (
  <td className="py-3.5 px-4 text-right">
    <div className="flex items-center justify-end gap-3">
      <label className="relative inline-flex items-center cursor-pointer">
        <input
          type="checkbox"
          checked={model.isActive}
          onChange={() => toggleModelStatus(model.id)}
          className="sr-only peer"
        />
        <div className="w-9 h-5 bg-[#1b2750] rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#3347e0]"></div>
      </label>
    </div>
  </td>
)}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 w-full">
          {modelStats.map((stat) => (
            <StatCard key={stat.id} {...stat} />
          ))}
        </div>

        {/* Modal إضافة نموذج جديد (يظهر للأدمن فقط) */}
        {isAdmin && isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div className={`${panel} w-full max-w-lg bg-[#0b132b] border-[#2a3a78]`}>
              <div className="flex items-center justify-between border-b border-[#1b2750] pb-3 mb-4">
                <h3 className="text-lg font-semibold text-white">Add New Model</h3>
                <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white">
                  <X size={20} />
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-300">Provider Name</label>
                  <select
                    value={newModel.provider}
                    onChange={(e) => setNewModel({ ...newModel, provider: e.target.value })}
                    className={field}
                  >
                    <option value="">Select a provider...</option>
                    {PROVIDER_OPTIONS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-300">Model Display Name</label>
                  <input
                    type="text"
                    placeholder="e.g. GPT-4.5 Turbo"
                    value={newModel.displayName}
                    onChange={(e) => setNewModel({ ...newModel, displayName: e.target.value })}
                    className={field}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-300">Input Price / 1M Tokens ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="2.50"
                      value={newModel.inputPrice}
                      onChange={(e) => setNewModel({ ...newModel, inputPrice: e.target.value })}
                      className={field}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-300">Output Price / 1M Tokens ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="10.00"
                      value={newModel.outputPrice}
                      onChange={(e) => setNewModel({ ...newModel, outputPrice: e.target.value })}
                      className={field}
                    />
                  </div>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3 border-t border-[#1b2750] pt-4">
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="rounded-lg border border-[#2a3a78] px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddModel}
                  disabled={submitting}
                  className="flex items-center gap-2 rounded-lg bg-[#3347e0] px-5 py-2 text-sm font-medium text-white hover:bg-[#4256f0] disabled:opacity-50"
                >
                  {submitting && <Loader2 size={14} className="animate-spin" />}
                  Save Model
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}