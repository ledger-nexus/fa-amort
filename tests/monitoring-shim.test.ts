// Unit tests for the fa-amort monitoring shim.
//
// Covers:
//   - PII redaction via the deep-clone helper (Confidentiality TSC)
//   - Fallback to console.error when SENTRY_DSN is unset (CC7.2)
//   - Error object handling — .message redacted, .name + .stack
//     preserved for triage
//   - captureMessage level-routing
//
// Does NOT cover the actual Sentry SDK integration — that requires a
// configured DSN + network and is tested in production via the smoke-
// signal trail (an obvious Sentry event on first deploy after wiring).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  redactPii,
  PII_FIELDS,
  stripStackPreamble,
  sanitizeErrorForCapture,
} from "../src/lib/soc2/redact-pii";
import {
  captureError,
  captureMessage,
} from "../src/lib/monitoring";

describe("redactPii — PII allowlist", () => {
  it("redacts every field in the canonical PII set", () => {
    const obj = {
      email: "alice@example.com",
      password: "hunter2",
      token: "tok_abc",
      apiKey: "key_xyz",
      description: "Asset purchased from Acme Corp",
      inputText: "raw AI input",
      outputJson: { secret: "value" },
      benign: "value",
    };
    const out = redactPii(obj);
    expect(out.email).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.description).toBe("[REDACTED]");
    expect(out.inputText).toBe("[REDACTED]");
    expect(out.outputJson).toBe("[REDACTED]");
    // Non-PII field passes through.
    expect(out.benign).toBe("value");
  });

  it("does NOT mutate the input object", () => {
    const obj = { email: "x@y.com", benign: 1 };
    const out = redactPii(obj);
    expect(obj.email).toBe("x@y.com"); // input untouched
    expect(out.email).toBe("[REDACTED]");
  });

  it("traverses arrays of objects", () => {
    const arr = [{ email: "a@x.com" }, { email: "b@y.com" }];
    const out = redactPii(arr);
    expect(out[0].email).toBe("[REDACTED]");
    expect(out[1].email).toBe("[REDACTED]");
  });

  it("redacts nested PII deep inside an object tree", () => {
    const obj = {
      level1: { level2: { email: "buried@example.com", other: "ok" } },
    };
    const out = redactPii(obj);
    expect(out.level1.level2.email).toBe("[REDACTED]");
    expect(out.level1.level2.other).toBe("ok");
  });

  it("preserves null + undefined + primitives", () => {
    expect(redactPii(null)).toBe(null);
    expect(redactPii(undefined)).toBe(undefined);
    expect(redactPii("hello")).toBe("hello");
    expect(redactPii(42)).toBe(42);
    expect(redactPii(true)).toBe(true);
  });

  it("redacts Error.message but keeps name + stack", () => {
    const err = new Error("Failed for user alice@example.com");
    const out = redactPii(err);
    expect(out.name).toBe("Error");
    expect(out.message).toBe("[REDACTED]");
    expect(out.stack).toBeTruthy();
  });

  it("14th-pass H1: strips PII from Error.stack preamble (V8 embeds message verbatim)", () => {
    // V8 produces stacks like "Error: <message>\n    at functionName (...)".
    // Without preamble stripping, redactPii(new Error("alice@x.com"))
    // leaks the email via .stack — a Confidentiality TSC violation.
    const err = new Error("Failed for user alice@example.com");
    const out = redactPii(err);
    expect(out.stack).not.toContain("alice@example.com");
    // The stack must still have frames so triage is possible.
    expect(out.stack).toContain("    at ");
    // And the redaction marker should be present where the message was.
    expect(out.stack).toContain("[REDACTED]");
  });

  it("14th-pass H1: stripStackPreamble handles missing/edge-case stacks", () => {
    expect(stripStackPreamble(undefined)).toBe(undefined);
    expect(stripStackPreamble("")).toBe("");
    // Non-V8-shaped stack (no "    at " frames) — pass through unchanged.
    expect(stripStackPreamble("custom error format")).toBe(
      "custom error format"
    );
    // Multi-line message before the first frame — strip everything
    // up to the first "    at ".
    const multiline =
      "Error: line 1\n  line 2 of message\n    at func (file:1:1)";
    const out = stripStackPreamble(multiline);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("    at func");
    expect(out).not.toContain("line 1");
    expect(out).not.toContain("line 2");
  });

  it("exports PII_FIELDS for audit trail", () => {
    expect(PII_FIELDS).toBeInstanceOf(Set);
    expect(PII_FIELDS.has("email")).toBe(true);
    expect(PII_FIELDS.has("password")).toBe(true);
    // Field-name-only — does NOT contain the value itself.
    expect(PII_FIELDS.has("benign")).toBe(false);
  });
});

describe("captureError — Sentry fallback path", () => {
  // SENTRY_DSN is unset in tests by default; if a future contributor
  // sets it in CI we explicitly clear it so the fallback path is
  // tested deterministically.
  const origDsn = process.env.SENTRY_DSN;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (origDsn) process.env.SENTRY_DSN = origDsn;
    consoleErrorSpy.mockRestore();
  });

  it("calls console.error with [monitoring] prefix when DSN absent", () => {
    captureError(new Error("boom"), { context: "test" });
    expect(consoleErrorSpy).toHaveBeenCalled();
    const args = consoleErrorSpy.mock.calls[0];
    expect(args[0]).toBe("[monitoring]");
  });

  it("does NOT pass raw err.message to console (Prisma column-value leak prevention)", () => {
    const err = new Error("Value Acme Corp violates unique constraint");
    captureError(err, { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    // The raw message must NOT appear in the console output.
    expect(serialized).not.toContain("Acme Corp");
    expect(serialized).not.toContain("violates unique constraint");
    // Only errName + errCode summary is included.
    expect(serialized).toContain("errName");
  });

  it("redacts PII from the extra context", () => {
    captureError(new Error("x"), {
      context: "test",
      extra: { email: "alice@example.com", benign: "value" },
    });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("value");
  });

  it("passes through non-Error primitives as errPrimitive", () => {
    captureError("string-error", { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    expect(serialized).toContain("errPrimitive");
    expect(serialized).toContain("string-error");
  });

  it("14th-pass M1: caps err.code at 16 chars (Neon driver embeds host:port in code)", () => {
    // Simulate a Neon serverless adapter wrapper that embeds the
    // host:port in .code on connection failures.
    const err = new Error("boom");
    (err as { code?: string }).code =
      "ECONNREFUSED: 10.0.1.42:5432 server-side";
    captureError(err, { context: "test" });
    const args = consoleErrorSpy.mock.calls[0];
    const serialized = JSON.stringify(args);
    // The IP must not survive — the cap defangs it.
    expect(serialized).not.toContain("10.0.1.42");
    expect(serialized).not.toContain(":5432");
    // The leading 16 chars are kept.
    expect(serialized).toContain("ECONNREFUSED: 10");
  });
});

describe("sanitizeErrorForCapture — Sentry path safety (14th-pass H1)", () => {
  it("returns non-Errors unchanged", () => {
    expect(sanitizeErrorForCapture("string-error")).toBe("string-error");
    expect(sanitizeErrorForCapture(42)).toBe(42);
    expect(sanitizeErrorForCapture(null)).toBe(null);
  });

  it("returns a NEW Error (doesn't mutate the caller's err)", () => {
    const original = new Error("Failed for alice@example.com");
    const out = sanitizeErrorForCapture(original);
    // The original is unchanged — caller's catch block can still use it.
    expect(original.message).toBe("Failed for alice@example.com");
    expect((out as Error).message).toBe("[REDACTED]");
    expect(out).not.toBe(original);
  });

  it("strips PII from the returned Error's .stack", () => {
    const original = new Error("Failed for alice@example.com");
    const out = sanitizeErrorForCapture(original) as Error;
    expect(out.stack).not.toContain("alice@example.com");
    expect(out.stack).toContain("[REDACTED]");
  });

  it("preserves Error class identity (instanceof + name)", () => {
    class MyError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "MyError";
      }
    }
    const original = new MyError("buried PII alice@x.com");
    const out = sanitizeErrorForCapture(original) as Error;
    // Sentry's grouping reads err.name for de-duplication.
    expect(out.name).toBe("MyError");
    // The returned object is still an Error (Sentry expects this).
    expect(out).toBeInstanceOf(Error);
  });
});

describe("captureMessage — level routing", () => {
  const origDsn = process.env.SENTRY_DSN;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (origDsn) process.env.SENTRY_DSN = origDsn;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("info → console.log", () => {
    captureMessage("informational", "info");
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("warning → console.warn", () => {
    captureMessage("warn", "warning");
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("error → console.error", () => {
    captureMessage("err", "error");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
