
"use client";

import { base_usrl } from "@/lib/base-url";
import { Eye, EyeOff, LockKeyhole, Mail, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const API_URL = base_usrl;
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const router = useRouter();

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setError("");
    setLoading(true);

    try {
      const response = await fetch(
        `${API_URL}/auth/login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email, password }),
        }
      );

      const data = await response.json();

      // Handle backend errors
      if (!response.ok) {
        let errorMessage = "Login failed. Please try again.";

        if (typeof data.detail === "string") {
          errorMessage = data.detail;
        } else if (Array.isArray(data.detail)) {
          errorMessage = data.detail
            .map((item: { msg: string }) => item.msg)
            .join(", ");
        }

        throw new Error(errorMessage);
      }

      // Check access token
      if (!data.access_token) {
        throw new Error("No access token received from server.");
      }

      // Remove previous tokens
      localStorage.removeItem("access_token");
      sessionStorage.removeItem("access_token");
      localStorage.removeItem("role");
      sessionStorage.removeItem("role");

      // Save access token
      if (rememberMe) {
        localStorage.setItem("access_token", data.access_token);
        if (data.user?.role) localStorage.setItem("role", data.user.role);
      } else {
        sessionStorage.setItem("access_token", data.access_token);
        if (data.user?.role) sessionStorage.setItem("role", data.user.role);
      }

      // Navigate to Dashboard
      router.push(data.user?.role === "admin" ? "/admin" : "/dashboard");

    } catch (err) {
      if (err instanceof TypeError) {
        setError("Unable to connect to the server. Please try again.");
      } else {
        setError(
          err instanceof Error ? err.message : "Something went wrong."
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#060b1f] text-white flex items-center justify-center p-4 overflow-hidden">
      <div className="w-full max-w-312.5 min-h-162.5 grid grid-cols-1 lg:grid-cols-2 rounded-2xl overflow-hidden border border-[#1b2b4a] shadow-2xl shadow-blue-950/30">

        {/* Left Section */}
        <section className="relative flex flex-col justify-center px-8 py-12 sm:px-16 bg-linear-to-br from-[#071634] via-[#07132b] to-[#080d20] overflow-hidden">

          {/* Background Effects */}
          <div className="absolute w-112.5 h-112.5 rounded-full bg-purple-700/10 blur-[100px] -top-40 -left-40" />

          <div className="absolute w-125 h-75 border border-purple-500/20 rounded-[50%] rotate-[-25deg] -bottom-40 -left-32" />

          <div className="absolute w-125 h-75 border border-blue-500/20 rounded-[50%] rotate-[-25deg] -bottom-48 -left-20" />

          <div className="relative z-10 max-w-md mx-auto lg:mx-0">

            {/* Logo */}
            <div className="w-14 h-14 rounded-xl bg-linear-to-br from-[#6255ed] to-[#3324a7] flex items-center justify-center mb-7 shadow-lg shadow-purple-900/40">
              <Sparkles size={30} className="text-white" />
            </div>

            <h1 className="text-4xl sm:text-5xl font-bold leading-tight">
              LLM Sandbox &
              <br />
              <span className="text-[#a5a5ff]">Cost Profiler</span>
            </h1>

            <p className="mt-6 text-lg text-gray-300">
              Compare. Evaluate. Optimize.
            </p>

            <p className="mt-5 text-sm leading-7 text-gray-400 max-w-sm">
              Test and compare multiple AI models, evaluate their responses,
              track token usage and costs, and find the best model for your
              needs.
            </p>

            <div className="mt-10 flex gap-3 text-xs text-gray-500">
              <span>Multi-model Testing</span>
              <span>•</span>
              <span>Cost Analysis</span>
              <span>•</span>
              <span>AI Evaluation</span>
            </div>

          </div>
        </section>

        {/* Right Section */}
        <section className="flex items-center justify-center bg-[#080f21] px-6 py-12 sm:px-12">

          <div className="w-full max-w-105">

            <div className="mb-8">
              <h2 className="text-3xl font-bold">
                Welcome back
              </h2>

              <p className="text-sm text-gray-400 mt-2">
                Enter your account details to continue.
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">

              {/* Email */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Email address
                </label>

                <div className="relative">
                  <Mail
                    size={18}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                  />

                  <input
                    type="email"
                    placeholder="Enter your email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full h-12 rounded-lg bg-[#111d34] border border-[#263753] pl-11 pr-4 text-sm text-white placeholder:text-gray-500 outline-none transition focus:border-[#6559ef] focus:ring-2 focus:ring-[#6559ef]/20"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label className="block text-sm font-medium mb-2">
                  Password
                </label>

                <div className="relative">
                  <LockKeyhole
                    size={18}
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                  />

                  <input
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-12 rounded-lg bg-[#111d34] border border-[#263753] pl-11 pr-12 text-sm text-white placeholder:text-gray-500 outline-none transition focus:border-[#6559ef] focus:ring-2 focus:ring-[#6559ef]/20"
                  />

                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                  >
                    {showPassword ? (
                      <EyeOff size={18} />
                    ) : (
                      <Eye size={18} />
                    )}
                  </button>
                </div>
              </div>

              {/* Error Message */}
              {error && (
                <p className="text-red-500 text-sm mt-2">
                  {error}
                </p>
              )}

              {/* Remember Me */}
              <div className="flex items-center justify-between text-sm">
                <label className="flex items-center gap-2 text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="accent-[#6255ed] w-4 h-4"
                  />
                  Remember me
                </label>

                <Link
                  href="/forgot-password"
                  className="text-[#9293ff] hover:text-white transition"
                >
                  Forgot password?
                </Link>
              </div>

              {/* Sign In */}
              <button
                type="submit"
                disabled={loading}
                className="w-full h-12 rounded-lg bg-[#393dcc] hover:bg-[#555af0] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm transition shadow-lg shadow-indigo-950/30"
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>

            </form>

            {/* Sign Up */}
            <p className="text-center text-sm text-gray-400 mt-7">
              Don&apos;t have an account?{" "}
              <Link
                href="/signup"
                className="text-[#9293ff] hover:text-white font-medium transition"
              >
                Sign up
              </Link>
            </p>

          </div>
        </section>
      </div>
    </main>
  );
}
