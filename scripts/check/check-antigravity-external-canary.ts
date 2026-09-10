import path from "node:path";
import {
  runAntigravityExternalCanary,
  CANARY_EXIT_CODES,
  type CanaryRunOptions,
} from "./antigravityCanaryCore.ts";
import type { AntigravityProfileId } from "@/shared/constants/antigravityClientProfile";

function printUsage(): void {
  console.log(
    "Usage: node --import tsx/esm scripts/check/check-antigravity-external-canary.ts --profile <cli|ide> [options]"
  );
  console.log("Options:");
  console.log("  --profile <cli|ide>          Client profile to verify (required)");
  console.log("  --approval <path>            Path to operator approval JSON file");
  console.log(
    "  --probe <path>               Path to canonical probe JSON file (default: fixtures)"
  );
  console.log(
    "  --manifest <path>            Path to reference manifest JSON file (default: fixtures)"
  );
  console.log(
    "  --output <path>              Path to write redacted artifact JSON (default: none)"
  );
}

function parseArgs(args: string[]): {
  profile?: AntigravityProfileId;
  approvalPath?: string;
  probePath?: string;
  manifestPath?: string;
  outputPath?: string;
} {
  const parsed: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--profile" && i + 1 < args.length) {
      const val = args[++i];
      if (val === "cli" || val === "ide") {
        parsed.profile = val;
      }
    } else if (arg === "--approval" && i + 1 < args.length) {
      parsed.approvalPath = args[++i];
    } else if (arg === "--probe" && i + 1 < args.length) {
      parsed.probePath = args[++i];
    } else if (arg === "--manifest" && i + 1 < args.length) {
      parsed.manifestPath = args[++i];
    } else if (arg === "--output" && i + 1 < args.length) {
      parsed.outputPath = args[++i];
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
  }
  return parsed;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.profile) {
    console.error("Error: --profile <cli|ide> is required.");
    printUsage();
    process.exit(CANARY_EXIT_CODES.ERROR);
  }

  // Environment fallback for approval file
  const approvalPath =
    options.approvalPath ||
    process.env.ANTIGRAVITY_CANARY_APPROVAL_PATH ||
    path.join(process.cwd(), "config/antigravity-canary-approval.json");

  const runOpts: CanaryRunOptions = {
    profile: options.profile,
    approvalPath,
    canonicalProbePath: options.probePath,
    referenceManifestPath: options.manifestPath,
    outputPath: options.outputPath,
  };

  const result = await runAntigravityExternalCanary(runOpts);

  console.log(
    JSON.stringify(
      {
        status: result.status,
        exitCode: result.exitCode,
        profile: result.profile,
        reasonCode: result.reasonCode,
        message: result.message,
        differenceCount: result.differences?.length ?? 0,
        differences: result.differences,
      },
      null,
      2
    )
  );

  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("check-antigravity-external-canary.ts")) {
  main().catch((err) => {
    console.error("Unexpected canary runner failure:", err);
    process.exit(CANARY_EXIT_CODES.ERROR);
  });
}
