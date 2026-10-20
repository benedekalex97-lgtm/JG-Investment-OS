import { getRuntime } from "@/server/db";
import { createApi } from "@/server/http/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = createApi(getRuntime);
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
