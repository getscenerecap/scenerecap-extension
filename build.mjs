import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });

const ctx = await esbuild.context({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    offscreen: "src/offscreen.ts",
    popup: "src/popup.ts",
    review: "src/review.ts",
    connect: "src/connect.ts",
  },
  bundle: true,
  outdir: "dist",
  format: "iife",
  target: "chrome120",
  minify: !watch,
  define: { "process.env.API_URL": JSON.stringify(process.env.API_URL ?? "http://localhost:4000"), "process.env.APP_URL": JSON.stringify(process.env.APP_URL ?? "http://localhost:3000") },
});

await ctx.rebuild();
cpSync("public", "dist", { recursive: true });
console.log("extension built -> dist/");
if (watch) await ctx.watch();
else await ctx.dispose();
