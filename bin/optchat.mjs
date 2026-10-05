#!/usr/bin/env node
// Launcher: runs the TypeScript sources directly through tsx (plain Node, no build step).
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
