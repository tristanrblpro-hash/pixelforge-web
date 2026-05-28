"use client";

import { useEffect, useState } from "react";

type HealthResponse = {
  ok: boolean;
  keys: {
    kie: boolean;
    anthropic: boolean;
    supabaseUrl: boolean;
    supabaseAnon: boolean;
    supabaseServiceRole: boolean;
  };
};

function Dot({ state }: { state: "ok" | "fail" | "idle" }) {
  const cls =
    state === "ok"
      ? "bg-pf-ok"
      : state === "fail"
      ? "bg-pf-danger"
      : "bg-pf-muted";
  return <span className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${cls}`} />;
}

export function StatusStrip() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        const data = (await r.json()) as HealthResponse;
        if (alive) setHealth(data);
      } catch {
        if (alive) setHealth(null);
      } finally {
        if (alive) setLoading(false);
      }
    }
    poll();
    const id = setInterval(poll, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const kie = loading ? "idle" : health?.keys.kie ? "ok" : "fail";
  const anth = loading ? "idle" : health?.keys.anthropic ? "ok" : "fail";
  const sb =
    loading
      ? "idle"
      : health?.keys.supabaseUrl && health?.keys.supabaseAnon
      ? "ok"
      : "fail";

  return (
    <div className="mt-auto pt-3 border-t border-pf-border text-xs text-pf-dim flex flex-col gap-1.5">
      <div>
        <Dot state={sb as "ok" | "fail" | "idle"} />
        Supabase: {loading ? "checking" : sb === "ok" ? "ok" : "missing"}
      </div>
      <div>
        <Dot state={kie as "ok" | "fail" | "idle"} />
        KIE.ai: {loading ? "checking" : kie === "ok" ? "ok" : "missing"}
      </div>
      <div>
        <Dot state={anth as "ok" | "fail" | "idle"} />
        Anthropic: {loading ? "checking" : anth === "ok" ? "ok" : "missing"}
      </div>
    </div>
  );
}
