/**
 * CAITLYN persisted credential and provider environment mapping tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCredentialEnv,
  getAuthFilePath,
  getPersistedApiKey,
  getProviderEnvVars,
  persistApiKey,
  removeApiKey,
} from "../src/config/credentials.js";

const originalCaitlynHome = process.env.CAITLYN_HOME;

describe("credential persistence", () => {
  beforeEach(() => {
    process.env.CAITLYN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "caitlyn-auth-"));
  });

  afterEach(() => {
    if (originalCaitlynHome === undefined) delete process.env.CAITLYN_HOME;
    else process.env.CAITLYN_HOME = originalCaitlynHome;
  });

  it("stores keys atomically in a private file selected at call time", () => {
    persistApiKey("deepseek", "test-secret-value");
    const authFile = getAuthFilePath();

    expect(getPersistedApiKey("deepseek")).toBe("test-secret-value");
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(authFile)).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(`${authFile}.tmp-${process.pid}`)).toBe(false);
  });

  it("removes only the selected provider credential", () => {
    persistApiKey("deepseek", "deepseek-key");
    persistApiKey("openrouter", "openrouter-key");
    removeApiKey("deepseek");

    expect(getPersistedApiKey("deepseek")).toBeUndefined();
    expect(getPersistedApiKey("openrouter")).toBe("openrouter-key");
  });
});

describe("provider environment mapping", () => {
  it("matches current pi-ai names for major providers", () => {
    expect(getProviderEnvVars("google")).toEqual(["GEMINI_API_KEY"]);
    expect(getProviderEnvVars("zai")).toEqual(["ZAI_API_KEY"]);
    expect(getProviderEnvVars("moonshotai")).toEqual(["MOONSHOT_API_KEY"]);
    expect(getProviderEnvVars("minimax-cn")).toEqual(["MINIMAX_CN_API_KEY"]);
  });

  it("builds a one-provider environment without mutating process.env", () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    const env = buildCredentialEnv("deepseek", "temporary-key");

    expect(env).toEqual({ DEEPSEEK_API_KEY: "temporary-key" });
    expect(process.env.DEEPSEEK_API_KEY).toBe(previous);
    expect(buildCredentialEnv("unknown", "temporary-key")).toBeUndefined();
  });
});
