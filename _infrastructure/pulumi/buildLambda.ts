import * as path from "node:path";
import * as esbuild from "esbuild";

// Bundles the Lambdas at synth time so preview/up never depend on a ../../dist that
// nobody remembered to build. The Pulumi workflows only install deps in this dir.
//
// CJS so the handler stays "index.handler" with no ESM resolution weirdness. Nothing is
// external, @aws-sdk included: the SDK baked into the Lambda runtime doesn't have
// client-lambda-microvms yet, and I'm not betting a deploy on when it will.
function buildLambdaBundle(entryPoint: string, outDirName: string): string {
  const outDir = path.join(__dirname, "build", outDirName);

  esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.join(outDir, "index.js"),
    // Handler source is in ../../src but its deps install here. src/ isn't an ancestor
    // of this dir, so esbuild won't find them without being told where to look.
    nodePaths: [path.join(__dirname, "node_modules")],
  });

  return outDir;
}

export const webhookBuildDir = buildLambdaBundle(
  path.join(__dirname, "../../src/webhook/handler.ts"),
  "webhook",
);

export const dispatcherBuildDir = buildLambdaBundle(
  path.join(__dirname, "../../src/dispatcher/handler.ts"),
  "dispatcher",
);
