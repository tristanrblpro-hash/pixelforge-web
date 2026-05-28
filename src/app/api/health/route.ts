import { NextResponse } from "next/server";
import { readKeyStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    keys: readKeyStatus(),
    ts: Date.now(),
  });
}
