import { NextResponse } from "next/server";

import { checkHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * The machine-readable check: Supabase reachable, schema applied, and which
 * optional variables are configured. `/status` is the human version.
 */
export async function GET() {
  const report = await checkHealth();
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
