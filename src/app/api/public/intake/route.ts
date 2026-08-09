import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // TODO (KAIA-2912): Replace with actual backend call once
    // POST /api/public/intake is delivered by Backend Developer
    console.log("[intake] Received intake submission:", {
      business_name: body.business_name,
      sector: body.sector,
      billing_email: body.billing_email,
    });

    return NextResponse.json(
      { ok: true, message: "Intake received" },
      { status: 200 }
    );
  } catch (err) {
    console.error("[intake] Error processing submission:", err);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
