import crypto from "node:crypto";
import path from "node:path";
import { stripLineNumbers } from "./deepThinkPurifier.ts";

export const MAX_ATTACHMENT_FILES_PER_TURN = 8;
export const READ_TOOL_DEFAULT_LIMIT = 10000;
export const READ_TOOL_DEFAULT_OFFSET = 1;

export interface ExtractedFileRef {
  originalRef: string;
  cleanRef: string;
}

export interface ReadToolSpec {
  available: boolean;
  toolName: string;
  paramName: string;
  requiresAbsolute: boolean;
  supportsLimit: boolean;
  supportsOffset: boolean;
}

export interface SyntheticToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  filePath: string;
  originalRef: string;
}

export interface ResolvedFileDocument {
  filePath: string;
  originalRef: string;
  content: string;
}

export type AttachmentPreflightAnalysis =
  | {
      status: "NO_ATTACHMENTS";
    }
  | {
      status: "TOO_MANY_FILES";
      count: number;
      files: string[];
      error: string;
    }
  | {
      status: "REQUEST_NEEDED";
      toolCalls: SyntheticToolCall[];
      genuineUserTurnIndex: number;
      genuineUserText: string;
    }
  | {
      status: "FAILED";
      error: string;
      failedFile?: string;
    }
  | {
      status: "COMPLETE";
      resolvedFiles: ResolvedFileDocument[];
      genuineUserTurnIndex: number;
      genuineUserText: string;
    };

/**
 * Extracts @file references from user text, strictly excluding:
 * - fenced code blocks (``` or ~~~)
 * - inline code (`...`)
 * - email addresses (user@domain.com)
 * - escaped @ (\@path)
 *
 * Supports:
 * - @"path with spaces/file.txt"
 * - @'path with spaces/file.txt'
 * - @path/to/file.ext
 * - @/abs/path/file.ext
 * - @file.ext
 */
export function extractFileReferences(text: string): string[] {
  if (!text || typeof text !== "string") return [];

  // 1. Mask fenced code blocks
  let masked = text.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (m) => " ".repeat(m.length));

  // 2. Mask inline code
  masked = masked.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));

  // 3. Mask email addresses
  masked = masked.replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, (m) =>
    " ".repeat(m.length)
  );

  // 4. Mask escaped \@
  masked = masked.replace(/\\@/g, "  ");

  const refs: string[] = [];

  // 5. Match quoted paths: @"path with spaces" or @'path with spaces'
  const quotedRegex = /@(["'])(.+?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = quotedRegex.exec(masked)) !== null) {
    const rawPath = match[2].trim();
    if (rawPath) {
      refs.push(rawPath);
    }
  }

  // Mask already captured quoted paths so unquoted regex doesn't re-match
  masked = masked.replace(/@(["'])(.+?)\1/g, (m) => " ".repeat(m.length));

  // 6. Match unquoted paths: @relative/path or @/absolute/path or @file.ext
  // Must be preceded by start of line, whitespace, or punctuation like (, [, {, <
  const unquotedRegex = /(?:^|[\s(\[{<])@([^\s"'`()[\]{}<>:;,!?]+)/g;
  while ((match = unquotedRegex.exec(masked)) !== null) {
    let candidate = match[1].trim();
    // Strip trailing punctuation like ., ,, ;, :, !, ?, )
    candidate = candidate.replace(/[.,;:!?)]+$/, "");

    // Must have a path separator (/ or \) OR a file extension (\.[a-zA-Z0-9_-]+)
    const hasSlash = candidate.includes("/") || candidate.includes("\\");
    const hasExtension = /\.[a-zA-Z0-9_-]{1,10}$/.test(candidate);

    if (candidate && (hasSlash || hasExtension)) {
      refs.push(candidate);
    }
  }

  // Deduplicate preserving first-seen order
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const ref of refs) {
    if (!seen.has(ref)) {
      seen.add(ref);
      deduped.push(ref);
    }
  }

  return deduped;
}

/**
 * Extracts a single `Primary working directory:` value from system text as a
 * resolution hint for tools that require absolute paths.
 * Returns { workspaceRoot: null, hasConflict: true } if multiple conflicting roots exist.
 */
export function extractPrimaryWorkingDirectory(system: unknown): {
  workspaceRoot: string | null;
  hasConflict: boolean;
} {
  let systemStr = "";
  if (typeof system === "string") {
    systemStr = system;
  } else if (Array.isArray(system)) {
    systemStr = system
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text: unknown }).text || "");
        }
        return "";
      })
      .join("\n\n");
  } else if (system && typeof system === "object" && "text" in system) {
    systemStr = String((system as { text: unknown }).text || "");
  }

  if (!systemStr) {
    return { workspaceRoot: null, hasConflict: false };
  }

  const pwdRegex = /(?:^|\n)[ \t]*Primary working directory:[ \t]*([^\n\r]+)/gi;
  const roots: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pwdRegex.exec(systemStr)) !== null) {
    const r = m[1].trim();
    if (r) {
      roots.push(r);
    }
  }

  const uniqueRoots = Array.from(new Set(roots));
  if (uniqueRoots.length === 1) {
    return { workspaceRoot: uniqueRoots[0], hasConflict: false };
  }
  if (uniqueRoots.length > 1) {
    return { workspaceRoot: null, hasConflict: true };
  }
  return { workspaceRoot: null, hasConflict: false };
}

/**
 * Safely resolves a path for the Read tool without proxy-side filesystem execution.
 * Checks for path traversal (..) escaping workspace root.
 */
export function resolveFilePath(
  rawPath: string,
  options: {
    workspaceRoot: string | null;
    hasConflict: boolean;
    requiresAbsolute: boolean;
  }
): { resolvedPath: string; error?: string } {
  const isPosixAbsolute = path.posix.isAbsolute(rawPath);
  const isWinAbsolute = path.win32.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath);
  const isAbsolute = isPosixAbsolute || isWinAbsolute;

  if (isAbsolute) {
    return { resolvedPath: rawPath };
  }

  // Relative path
  if (!options.requiresAbsolute) {
    // Client Read tool accepts relative paths — do not tamper
    return { resolvedPath: rawPath };
  }

  // Tool requires absolute path
  if (options.hasConflict) {
    return {
      resolvedPath: "",
      error: `Ambiguous workspace roots in system prompt: cannot safely resolve relative path "@${rawPath}". Please use an absolute file path.`,
    };
  }

  if (!options.workspaceRoot) {
    return {
      resolvedPath: "",
      error: `The Read tool requires an absolute path, but no Primary working directory hint was found in the system prompt. Please specify an absolute path for "@${rawPath}".`,
    };
  }

  // Check traversal
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === "..") {
    return {
      resolvedPath: "",
      error: `Path traversal outside workspace root is not allowed: "@${rawPath}".`,
    };
  }

  const rootNormalized = options.workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const relClean = normalized.replace(/^\.\//, "");
  const combined = `${rootNormalized}/${relClean}`;

  return { resolvedPath: combined };
}

/**
 * Inspects `body.tools` to check whether the client advertised a `Read` tool,
 * and extracts its parameter requirements (e.g. limit, offset, requiresAbsolute).
 */
export function inspectReadTool(tools: unknown): ReadToolSpec {
  if (!Array.isArray(tools)) {
    return {
      available: false,
      toolName: "Read",
      paramName: "file_path",
      requiresAbsolute: false,
      supportsLimit: false,
      supportsOffset: false,
    };
  }

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;

    // Check Claude format: { name: "Read", input_schema: { properties: ... } }
    // Check OpenAI format: { type: "function", function: { name: "Read", parameters: ... } }
    const name = String(
      (tool as { name?: string }).name ||
        (tool as { function?: { name?: string } }).function?.name ||
        ""
    );

    if (name.toLowerCase() === "read") {
      const schema =
        (tool as { input_schema?: Record<string, unknown> }).input_schema ||
        (tool as { function?: { parameters?: Record<string, unknown> } }).function?.parameters;

      const properties = (schema?.properties as Record<string, Record<string, unknown>>) || {};
      const paramName =
        "file_path" in properties ? "file_path" : "path" in properties ? "path" : "file_path";

      const paramDesc = String(properties[paramName]?.description || "").toLowerCase();
      const toolDesc = String(
        (tool as { description?: string }).description ||
          (tool as { function?: { description?: string } }).function?.description ||
          ""
      ).toLowerCase();

      const requiresAbsolute = paramDesc.includes("absolute") || toolDesc.includes("absolute");
      const supportsLimit = "limit" in properties;
      const supportsOffset = "offset" in properties;

      return {
        available: true,
        toolName: name,
        paramName,
        requiresAbsolute,
        supportsLimit,
        supportsOffset,
      };
    }
  }

  return {
    available: false,
    toolName: "Read",
    paramName: "file_path",
    requiresAbsolute: false,
    supportsLimit: false,
    supportsOffset: false,
  };
}

/**
 * Generates a deterministic, stable tool_use ID.
 * ID = version + anchorDigest + refIndex + filePath + argsDigest
 */
export function generateToolUseId(params: {
  version?: string;
  anchorDigest: string;
  refIndex: number;
  filePath: string;
  args: Record<string, unknown>;
  format: "claude" | "openai";
}): string {
  const version = params.version || "v1";
  const hash = crypto
    .createHash("sha256")
    .update(
      `${version}:${params.anchorDigest}:${params.refIndex}:${params.filePath}:${JSON.stringify(params.args)}`
    )
    .digest("hex")
    .slice(0, 16);

  return params.format === "claude" ? `toolu_dt_read_${hash}` : `call_dt_read_${hash}`;
}

/**
 * Checks if a string contains common Read tool truncation markers.
 */
export function detectTruncation(content: string): boolean {
  if (!content || typeof content !== "string") return false;
  return /(?:\[\.\.\..*?truncated.*?\]|\[truncated\]|output truncated|lines truncated)/i.test(
    content
  );
}

/**
 * Helper to extract plain text from message content, ignoring tool_result / tool_use blocks.
 */
export function extractPlainTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const block = item as { type?: string; text?: unknown };
        if (block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
    return parts.join("\n\n");
  }
  if (content && typeof content === "object" && "text" in content) {
    const textVal = (content as { text: unknown }).text;
    if (typeof textVal === "string") return textVal;
  }
  return "";
}

/**
 * Checks if a message is purely a tool_result or tool response turn without a genuine user question.
 */
export function isToolResultTurn(message: { role: string; content: unknown }): boolean {
  if (message.role === "tool") return true;
  if (message.role === "user" && Array.isArray(message.content)) {
    const blocks = message.content as Array<{ type?: string }>;
    const hasToolResult = blocks.some((b) => b && b.type === "tool_result");
    const hasText = blocks.some(
      (b) => b && b.type === "text" && String(b.text || "").trim().length > 0
    );
    return hasToolResult && !hasText;
  }
  return false;
}

/**
 * Pure analyzer for Deep Think attachment preflight.
 * Inspects conversation history, detects unresolved @file references, validates
 * client tool_use/tool_result state, and produces the preflight decision.
 */
export function analyzeAttachmentPreflight(params: {
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
  tools?: unknown;
  tool_choice?: unknown;
  system?: unknown;
  format: "claude" | "openai";
}): AttachmentPreflightAnalysis {
  const { messages, tools, tool_choice, system, format } = params;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { status: "NO_ATTACHMENTS" };
  }

  // 1. Find the latest genuine user question turn
  let genuineUserTurnIndex = -1;
  let genuineUserText = "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && !isToolResultTurn(msg)) {
      const text = extractPlainTextContent(msg.content);
      if (text.trim().length > 0) {
        genuineUserTurnIndex = i;
        genuineUserText = text;
        break;
      }
    }
  }

  if (genuineUserTurnIndex === -1 || !genuineUserText.trim()) {
    return { status: "NO_ATTACHMENTS" };
  }

  // 2. Extract @file references from the genuine user question
  const fileRefs = extractFileReferences(genuineUserText);
  if (fileRefs.length === 0) {
    return { status: "NO_ATTACHMENTS" };
  }

  if (fileRefs.length > MAX_ATTACHMENT_FILES_PER_TURN) {
    return {
      status: "TOO_MANY_FILES",
      count: fileRefs.length,
      files: fileRefs,
      error: `Too many file references in a single turn (found ${fileRefs.length}, maximum is ${MAX_ATTACHMENT_FILES_PER_TURN}). Please reduce the number of referenced files.`,
    };
  }

  // 3. Inspect Read tool availability and parameters
  const toolSpec = inspectReadTool(tools);
  if (!toolSpec.available) {
    return {
      status: "FAILED",
      error: `The prompt references files (${fileRefs.map((f) => `@${f}`).join(", ")}), but the client does not advertise a compatible "Read" tool.`,
    };
  }

  if (tool_choice === "none") {
    return {
      status: "FAILED",
      error: `The prompt references files (${fileRefs.map((f) => `@${f}`).join(", ")}), but tool calls are explicitly disabled (tool_choice: "none").`,
    };
  }

  // 4. Resolve file paths and check traversal
  const pwdInfo = extractPrimaryWorkingDirectory(system);
  const resolvedPathList: Array<{ originalRef: string; resolvedPath: string }> = [];

  for (const ref of fileRefs) {
    const res = resolveFilePath(ref, {
      workspaceRoot: pwdInfo.workspaceRoot,
      hasConflict: pwdInfo.hasConflict,
      requiresAbsolute: toolSpec.requiresAbsolute,
    });
    if (res.error) {
      return {
        status: "FAILED",
        error: res.error,
        failedFile: ref,
      };
    }
    resolvedPathList.push({ originalRef: ref, resolvedPath: res.resolvedPath });
  }

  // 5. Compute anchor digest for this genuine user turn
  const anchorDigest = crypto
    .createHash("sha256")
    .update(`turn:${genuineUserTurnIndex}|role:user|text:${genuineUserText.trim()}`)
    .digest("hex")
    .slice(0, 16);

  // 6. Generate expected tool calls
  const expectedToolCalls: SyntheticToolCall[] = resolvedPathList.map((item, idx) => {
    const args: Record<string, unknown> = {
      [toolSpec.paramName]: item.resolvedPath,
    };
    if (toolSpec.supportsLimit) {
      args.limit = READ_TOOL_DEFAULT_LIMIT;
    }
    if (toolSpec.supportsOffset) {
      args.offset = READ_TOOL_DEFAULT_OFFSET;
    }

    const id = generateToolUseId({
      anchorDigest,
      refIndex: idx,
      filePath: item.resolvedPath,
      args,
      format,
    });

    return {
      id,
      name: toolSpec.toolName,
      args,
      filePath: item.resolvedPath,
      originalRef: item.originalRef,
    };
  });

  // 7. Inspect turns occurring strictly AFTER genuineUserTurnIndex
  const subsequentTurns = messages.slice(genuineUserTurnIndex + 1);

  // Collect assistant tool calls made after genuine turn
  const assistantToolCallsMade = new Map<
    string,
    { id: string; name: string; input: Record<string, unknown> }
  >();
  for (const turn of subsequentTurns) {
    if (turn.role === "assistant") {
      // Claude content array
      if (Array.isArray(turn.content)) {
        for (const item of turn.content) {
          if (item && typeof item === "object" && (item as { type?: string }).type === "tool_use") {
            const tu = item as { id: string; name: string; input: Record<string, unknown> };
            assistantToolCallsMade.set(tu.id, tu);
          }
        }
      }
      // OpenAI tool_calls
      if (Array.isArray(turn.tool_calls)) {
        for (const tc of turn.tool_calls as Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>) {
          if (tc && tc.id) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.function?.arguments || "{}");
            } catch {}
            assistantToolCallsMade.set(tc.id, {
              id: tc.id,
              name: tc.function?.name || "Read",
              input: parsedArgs,
            });
          }
        }
      }
    }
  }

  // If the assistant has NOT yet requested all required tool calls:
  const allRequested = expectedToolCalls.every((tc) => assistantToolCallsMade.has(tc.id));
  if (!allRequested) {
    return {
      status: "REQUEST_NEEDED",
      toolCalls: expectedToolCalls,
      genuineUserTurnIndex,
      genuineUserText,
    };
  }

  // 8. The assistant DID request the files. Check for matching tool_results!
  const toolResultsMap = new Map<string, { content: string; isError: boolean; found: boolean }>();

  for (const turn of subsequentTurns) {
    // Claude user message with tool_result
    if (turn.role === "user" && Array.isArray(turn.content)) {
      for (const item of turn.content) {
        if (
          item &&
          typeof item === "object" &&
          (item as { type?: string }).type === "tool_result"
        ) {
          const tr = item as { tool_use_id?: string; content?: unknown; is_error?: boolean };
          if (tr.tool_use_id) {
            let rawContent = "";
            if (typeof tr.content === "string") {
              rawContent = tr.content;
            } else if (Array.isArray(tr.content)) {
              rawContent = tr.content
                .map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text || ""))
                .join("\n");
            }
            toolResultsMap.set(tr.tool_use_id, {
              content: rawContent,
              isError: Boolean(tr.is_error),
              found: true,
            });
          }
        }
      }
    }
    // OpenAI role: "tool"
    if (turn.role === "tool") {
      const tcId = (turn as { tool_call_id?: string }).tool_call_id;
      if (tcId) {
        let rawContent = "";
        if (typeof turn.content === "string") {
          rawContent = turn.content;
        } else if (Array.isArray(turn.content)) {
          rawContent = turn.content
            .map((c) => (typeof c === "string" ? c : (c as { text?: string })?.text || ""))
            .join("\n");
        }
        toolResultsMap.set(tcId, {
          content: rawContent,
          isError: false,
          found: true,
        });
      }
    }
  }

  // Verify each expected tool call has a valid, non-error, complete tool_result
  const resolvedFiles: ResolvedFileDocument[] = [];

  for (const tc of expectedToolCalls) {
    const tr = toolResultsMap.get(tc.id);
    if (!tr || !tr.found) {
      return {
        status: "FAILED",
        error: `Missing tool_result for file "@${tc.originalRef}" (expected tool call ID ${tc.id}).`,
        failedFile: tc.originalRef,
      };
    }

    if (tr.isError) {
      return {
        status: "FAILED",
        error: `Client failed to read file "@${tc.originalRef}": ${tr.content || "Error reported by Read tool"}`,
        failedFile: tc.originalRef,
      };
    }

    if (detectTruncation(tr.content)) {
      return {
        status: "FAILED",
        error: `Read output for file "@${tc.originalRef}" was truncated by the client. Cannot forward incomplete document to Gemini Deep Think.`,
        failedFile: tc.originalRef,
      };
    }

    const cleanedContent = stripLineNumbers(tr.content);
    resolvedFiles.push({
      filePath: tc.filePath,
      originalRef: tc.originalRef,
      content: cleanedContent,
    });
  }

  return {
    status: "COMPLETE",
    resolvedFiles,
    genuineUserTurnIndex,
    genuineUserText,
  };
}
