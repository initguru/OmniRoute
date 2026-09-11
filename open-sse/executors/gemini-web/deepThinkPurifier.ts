/**
 * Context purifier for Gemini Web Deep Think.
 *
 * Strips CLI terminal boilerplate, hook instructions, and harness headers
 * (e.g. SessionStart hook, <EXTREMELY[-_]IMPORTANT>, x-anthropic-billing-header,
 * MCP Server Instructions, Delegation, Capability/Contract rules, <system-reminder>
 * blocks) while preserving user-referenced documents and genuine domain instructions,
 * stripping cat -n line numbers from Read tool outputs, and prominently anchoring
 * the core user question.
 */

export interface PurifiedPromptResult {
  prompt: string;
  hasUserContent: boolean;
  extractedDocs: string[];
  userQuestion: string;
}

const HARNESS_FILES = new Set([
  "context7.md",
  "claude.md",
  "agents.md",
  "gemini.md",
  "memory.md",
  "llm.txt",
  "settings.json",
  "settings.local.json",
]);

export function normalizeDocumentPath(rawPath: string): {
  cleanPath: string;
  fileName: string;
  lowerName: string;
} {
  const cleanPath = rawPath.replace(/\s*\([^)]*\)$/, "").trim();
  const fileName = cleanPath.split("/").pop() || cleanPath;
  const lowerName = fileName.toLowerCase();
  return { cleanPath, fileName, lowerName };
}

/**
 * Strips line number prefixes (e.g. `1\t`, `     1\t`, ` 123   `) produced
 * by `cat -n` or Claude Code's Read tool from every line.
 */
export function stripLineNumbers(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\d+(?:\t|[ ]{1,4}|$)/, ""))
    .join("\n");
}

const BOILERPLATE_LINE_PATTERNS: readonly RegExp[] = [
  /^x-anthropic-[a-z0-9-]+:/i,
  /^You are Claude Code/i,
  /^You are a Claude agent/i,
  /^You are an agent for Claude Code/i,
  /^SessionStart hook/i,
  /^#+ Mandatory Parent Edit Barrier/i,
  /^#+ Zero Direct Source Edit Policy/i,
  /^#+ File-edit tool reliability/i,
  /^#+ Tool-call declaration/i,
  /^#+ Delegation/i,
  /^#+ 공통 실행 통제 규칙/i,
  /^#+ Claude Code overlay/i,
  /^#+ Root-only delegation boundary/i,
  /^#+ MCP Server Instructions/i,
  /^#+ (?:CLI )?Harness/i,
  /^#+ Memory\b/i,
  /^#+ Superpowers\b/i,
  /^#+ Available agent types\b/i,
  /^Available agent types:/i,
  /^#+ The Rule\b/i,
  /^The Rule\b/i,
  /^## Capability와 도구 사용/i,
  /^## Contract와 설계 경계/i,
  /^## 실행[·\s]격리[·\s]소유권/i,
  /^## 구현[·\s]검증[·\s]완료/i,
  /^gitStatus:/i,
  /^#+ gitStatus/i,
  /^Today's date is/i,
  /^#+ currentDate/i,
];

const BOILERPLATE_BLOCK_PATTERNS: readonly RegExp[] = [
  /<EXTREMELY[-_]IMPORTANT>[\s\S]*?<\/EXTREMELY[-_]IMPORTANT>/gi,
  /<context_window_protection>[\s\S]*?<\/context_window_protection>/gi,
  /<deferred_tool_bootstrap>[\s\S]*?<\/deferred_tool_bootstrap>/gi,
  /<tool_selection_hierarchy>[\s\S]*?<\/tool_selection_hierarchy>/gi,
  /<session_continuity>[\s\S]*?<\/session_continuity>/gi,
  /<priority_instructions>[\s\S]*?<\/priority_instructions>/gi,
  /<context_guidance>[\s\S]*?<\/context_guidance>/gi,
  /<env>[\s\S]*?<\/env>/gi,
  /<total_tokens>[\s\S]*?<\/total_tokens>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /(?:^|\n)[ \t]*#+\s*MCP Server Instructions\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|Use this server|Do not use for|The following MCP servers|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Delegation\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|Role terms|Only the root|Any instruction|A subagent|\||\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Root-only delegation boundary\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*공통 실행 통제 규칙\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|client·model|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Mandatory Parent Edit Barrier\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Zero Direct Source Edit Policy\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*File-edit tool reliability\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Tool-call declaration\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Claude Code overlay\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*(?:CLI )?Harness\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Memory\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Superpowers\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Available agent types\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*Available agent types:[\s\S]*?(?=(?:\n\n[A-Za-z0-9#가-힣])|$)/gi,
  /(?:^|\n)[ \t]*#+\s*gitStatus[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*gitStatus:[\s\S]*?(?=(?:\n\n[A-Za-z0-9#가-힣])|$)/gi,
  /(?:^|\n)[ \t]*(?:#+\s*currentDate\s*\n)?Today's date is \d{4}-\d{2}-\d{2}\.?[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*#+\s*currentDate[\s\S]*?(?=(?:\n[ \t]*#(?!#) |$))/gi,
  /(?:^|\n)[ \t]*(?:#+\s*)?The Rule\b[^\n]*\n([\s\S]*?)(?=(?:\n[ \t]*#(?!#) |\n\n[A-Za-z0-9#가-힣]|$))/gi,
  /The following skills are available for use with the Skill tool:[\s\S]*?(?=(?:\n\n[A-Za-z0-9#가-힣])|$)/gi,
  /In this environment you have access to a set of tools[\s\S]*?(?=(?:\n\n[A-Za-z0-9#가-힣])|$)/gi,
  /Guidelines:\s*\n(?:[ \t]*-[^\n]*\n?)+/gi,
  /Your strengths:\s*\n(?:[ \t]*-[^\n]*\n?)+/gi,
];

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        textParts.push(part);
      } else if (part && typeof part === "object") {
        const item = part as { type?: unknown; text?: unknown };
        if (typeof item.text === "string") {
          textParts.push(item.text);
        }
      }
    }
    return textParts.join("");
  }
  if (content && typeof content === "object") {
    const item = content as { text?: unknown };
    if (typeof item.text === "string") return item.text;
  }
  return "";
}

export function stripHarnessBoilerplate(raw: string): string {
  let cleaned = raw;

  for (const blockPattern of BOILERPLATE_BLOCK_PATTERNS) {
    cleaned = cleaned.replace(blockPattern, "\n");
  }

  const lines = cleaned.split("\n");
  const filteredLines: string[] = [];
  let skippingBoilerplateSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (BOILERPLATE_LINE_PATTERNS.some((p) => p.test(trimmed))) {
      skippingBoilerplateSection = true;
      continue;
    }

    if (skippingBoilerplateSection) {
      if (trimmed === "") {
        skippingBoilerplateSection = false;
      } else if (
        trimmed.startsWith("#") &&
        !BOILERPLATE_LINE_PATTERNS.some((p) => p.test(trimmed))
      ) {
        skippingBoilerplateSection = false;
      } else {
        continue;
      }
    }

    if (
      trimmed.includes("You have superpowers") ||
      trimmed.includes("SDD boundaries") ||
      trimmed.includes("feature-dev boundaries") ||
      trimmed.includes("SessionStart hook") ||
      trimmed.includes("Capability와 도구 사용") ||
      trimmed.includes("Contract와 설계 경계") ||
      trimmed.includes("실행·격리·소유권") ||
      trimmed.includes("구현·검증·완료")
    ) {
      continue;
    }

    filteredLines.push(line);
  }

  return filteredLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeSystemPrompt(raw: string): string {
  return stripHarnessBoilerplate(raw);
}

function extractDocsFromSystemReminder(srBody: string, extractedDocs: string[]): void {
  const contentsOfRegex =
    /(?:^|\n)[ \t]*Contents of ([^\n:]+):\s*\n([\s\S]*?)(?=(?:\n[ \t]*Contents of |\n[ \t]*# |\n[ \t]*<[a-z0-9_-]+|$))/gi;
  let match: RegExpExecArray | null;

  while ((match = contentsOfRegex.exec(srBody)) !== null) {
    const rawPath = match[1].trim();
    const content = match[2].trim();
    const { fileName, lowerName } = normalizeDocumentPath(rawPath);

    if (!HARNESS_FILES.has(lowerName)) {
      extractedDocs.push(`Contents of ${fileName}:\n${content}`);
    }
  }

  const fileTagRegex =
    /(?:^|\n)[ \t]*<file(?:\s+(?:path|name)="([^"]*)")?>\s*([\s\S]*?)\s*<\/file>/gi;
  while ((match = fileTagRegex.exec(srBody)) !== null) {
    const rawPath = (match[1] || "").trim();
    const content = match[2].trim();
    const { lowerName } = normalizeDocumentPath(rawPath);

    if (!HARNESS_FILES.has(lowerName)) {
      extractedDocs.push(rawPath ? `<file path="${rawPath}">\n${content}\n</file>` : content);
    }
  }
}

function extractReadToolOutputs(text: string): {
  cleanedText: string;
  readDocs: string[];
} {
  const readDocs: string[] = [];

  const readToolCallRegex =
    /(?:^|\n)[ \t]*Called the Read tool with the following input:\s*(\{[\s\S]*?\})\s*[\s\S]*?Result of calling the Read tool:\s*\n/gi;

  let cleaned = text;
  let match: RegExpExecArray | null;

  while ((match = readToolCallRegex.exec(cleaned)) !== null) {
    const fullMatch = match[0];
    const matchIndex = match.index;
    const jsonStr = match[1];

    let filePath = "";
    try {
      const parsed = JSON.parse(jsonStr) as { file_path?: string };
      if (typeof parsed.file_path === "string") {
        filePath = parsed.file_path;
      }
    } catch {
      const fpMatch = /"file_path"\s*:\s*"([^"]+)"/.exec(jsonStr);
      if (fpMatch) filePath = fpMatch[1];
    }

    const afterHeader = cleaned.slice(matchIndex + fullMatch.length);
    const lines = afterHeader.split("\n");
    const outputLines: string[] = [];

    let consumedLines = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\d+(?:\t|[ ]{1,4}|$)/.test(line)) {
        outputLines.push(line);
        consumedLines = i + 1;
      } else if (line.trim() === "") {
        let hasMoreNumbered = false;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (/^\s*\d+(?:\t|[ ]{1,4}|$)/.test(lines[j])) {
            hasMoreNumbered = true;
            break;
          }
          if (lines[j].trim() !== "") break;
        }
        if (hasMoreNumbered) {
          outputLines.push(line);
          consumedLines = i + 1;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    const { fileName, lowerName } = normalizeDocumentPath(filePath || "document");
    if (!HARNESS_FILES.has(lowerName) && outputLines.length > 0) {
      const rawContent = outputLines.join("\n");
      const stripped = stripLineNumbers(rawContent).trim();
      readDocs.push(`[참조 문서: ${fileName}]\n${stripped}`);
    }

    const consumedTextLength = lines.slice(0, consumedLines).join("\n").length;
    const totalBlockLength = fullMatch.length + (consumedLines > 0 ? consumedTextLength : 0);

    cleaned = cleaned.slice(0, matchIndex) + "\n" + cleaned.slice(matchIndex + totalBlockLength);

    readToolCallRegex.lastIndex = matchIndex;
  }

  // Also catch standalone Result of calling the Read tool:\n if any
  const standaloneResultRegex = /(?:^|\n)[ \t]*Result of calling the Read tool:\s*\n/gi;
  while ((match = standaloneResultRegex.exec(cleaned)) !== null) {
    const fullMatch = match[0];
    const matchIndex = match.index;
    const afterHeader = cleaned.slice(matchIndex + fullMatch.length);
    const lines = afterHeader.split("\n");
    const outputLines: string[] = [];

    let consumedLines = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\d+(?:\t|[ ]{1,4}|$)/.test(line)) {
        outputLines.push(line);
        consumedLines = i + 1;
      } else if (line.trim() === "") {
        let hasMoreNumbered = false;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (/^\s*\d+(?:\t|[ ]{1,4}|$)/.test(lines[j])) {
            hasMoreNumbered = true;
            break;
          }
          if (lines[j].trim() !== "") break;
        }
        if (hasMoreNumbered) {
          outputLines.push(line);
          consumedLines = i + 1;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    if (outputLines.length > 0) {
      const rawContent = outputLines.join("\n");
      const stripped = stripLineNumbers(rawContent).trim();
      readDocs.push(`[참조 문서: Read tool]\n${stripped}`);
    }

    const consumedTextLength = lines.slice(0, consumedLines).join("\n").length;
    const totalBlockLength = fullMatch.length + (consumedLines > 0 ? consumedTextLength : 0);

    cleaned = cleaned.slice(0, matchIndex) + "\n" + cleaned.slice(matchIndex + totalBlockLength);

    standaloneResultRegex.lastIndex = matchIndex;
  }

  return { cleanedText: cleaned, readDocs };
}

function processUserMessage(rawText: string): { userQuestion: string; extractedDocs: string[] } {
  let text = rawText;
  const extractedDocs: string[] = [];

  // 1. Extract docs from <system-reminder> blocks
  const systemReminderRegex = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi;
  let srMatch: RegExpExecArray | null;
  while ((srMatch = systemReminderRegex.exec(text)) !== null) {
    const srBody = srMatch[1];
    extractDocsFromSystemReminder(srBody, extractedDocs);
  }

  // Remove <system-reminder> and common wrapper tags
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  text = text.replace(/<\/?system-reminder>/gi, "");
  text = text.replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, "");
  text = text.replace(/<env>[\s\S]*?<\/env>/gi, "");

  // 2. Parse and extract Read tool calls
  const { cleanedText: textAfterRead, readDocs } = extractReadToolOutputs(text);
  text = textAfterRead;
  for (const doc of readDocs) {
    extractedDocs.push(doc);
  }

  // Remove any remaining tool call blocks (Bash, Edit, etc.)
  text = text.replace(
    /(?:^|\n)[ \t]*Called the [A-Za-z0-9_-]+ tool with the following input:[\s\S]*?(?:Result of calling the [A-Za-z0-9_-]+ tool:[\s\S]*?)?(?=(?:\n[ \t]*Called the [A-Za-z0-9_-]+ tool|\n[ \t]*# |\n[ \t]*<[a-z0-9_-]+|\n[ \t]*\[(?:사용자|시스템|참조|이전)|$))/gi,
    "\n"
  );

  // 3. Extract <file path="...">...</file>
  text = text.replace(
    /(?:^|\n)[ \t]*<file(?:\s+(?:path|name)="([^"]*)")?>\s*([\s\S]*?)\s*<\/file>(?:\n|$)/gi,
    (_match, path, content) => {
      const { lowerName } = normalizeDocumentPath(path || "");
      if (!path || !HARNESS_FILES.has(lowerName)) {
        const docHeader = path
          ? `<file path="${path}">\n${content.trim()}\n</file>`
          : content.trim();
        extractedDocs.push(docHeader);
      }
      return "\n";
    }
  );

  // 4. Extract Contents of <path> (explanation):
  text = text.replace(
    /(?:^|\n)[ \t]*Contents of ([^\n:]+):\s*\n([\s\S]*?)(?=(?:\n[ \t]*Contents of |\n[ \t]*<file|\n[ \t]*`{3,}|\n\n(?=[가-힣A-Z][^\n]*(?:[?.!]|해줘|해주세요|알려줘|바랍니다|설명해줘))|$))/gi,
    (_match, rawPath, content) => {
      const { fileName, lowerName } = normalizeDocumentPath(rawPath);
      if (!HARNESS_FILES.has(lowerName)) {
        extractedDocs.push(`Contents of ${fileName}:\n${content.trim()}`);
      }
      return "\n";
    }
  );

  // 5. Extract --- name ---
  text = text.replace(
    /(?:^|\n)[ \t]*---+[ \t]*([^\n]+?)[ \t]*---+[ \t]*\n([\s\S]*?)(?:\n[ \t]*---+[ \t]*|$)/gi,
    (_match, name, content) => {
      const { fileName, lowerName } = normalizeDocumentPath(name.trim());
      if (!HARNESS_FILES.has(lowerName)) {
        extractedDocs.push(`--- ${fileName} ---\n${content.trim()}`);
      }
      return "\n";
    }
  );

  // 6. Extract markdown code blocks
  text = text.replace(
    /(?:^|\n)[ \t]*(`{3,})([^\n]*)\n([\s\S]*?)\n[ \t]*\1(?:\n|$)/g,
    (_match, fence, lang, code) => {
      extractedDocs.push(`${fence}${lang}\n${code}\n${fence}`);
      return "\n";
    }
  );

  // 7. Strip all CLI harness / MCP / Superpowers / delegation boilerplate from remaining text
  text = stripHarnessBoilerplate(text);

  const userQuestion = text.trim();
  return { userQuestion, extractedDocs };
}

function sanitizeTurnText(text: string): string {
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  cleaned = cleaned.replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, "");
  cleaned = cleaned.replace(/<env>[\s\S]*?<\/env>/gi, "");
  cleaned = stripHarnessBoilerplate(cleaned);
  return cleaned.trim();
}

export function purifyDeepThinkPrompt(
  messages: Array<{ role: string; content: unknown }>,
  system?: unknown
): PurifiedPromptResult {
  const systemParts: string[] = [];

  if (system) {
    const text = extractMessageText(system);
    if (text.trim()) systemParts.push(text.trim());
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = extractMessageText(msg.content);
      if (text.trim()) systemParts.push(text.trim());
    }
  }

  const rawSystem = systemParts.join("\n\n");
  const sanitizedSystem = sanitizeSystemPrompt(rawSystem);

  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const textMessages = nonSystemMessages.map((m) => ({
    role: m.role,
    content: extractMessageText(m.content),
  }));

  const userIndices = textMessages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i !== -1);

  if (userIndices.length === 0) {
    return {
      prompt: "",
      hasUserContent: false,
      extractedDocs: [],
      userQuestion: "",
    };
  }

  const lastUserIdx = userIndices[userIndices.length - 1];
  const lastUserContent = textMessages[lastUserIdx].content;

  const { userQuestion, extractedDocs } = processUserMessage(lastUserContent);

  const hasUserContent = Boolean(userQuestion.trim() || extractedDocs.length > 0);
  if (!hasUserContent) {
    return {
      prompt: "",
      hasUserContent: false,
      extractedDocs: [],
      userQuestion: "",
    };
  }

  const priorTurns = textMessages.filter(
    (m, i) => i < lastUserIdx && (m.role === "user" || m.role === "assistant")
  );

  const priorLines: string[] = [];
  for (const turn of priorTurns) {
    const cleaned = sanitizeTurnText(turn.content);
    if (cleaned) {
      const roleLabel = turn.role === "assistant" ? "Assistant" : "User";
      priorLines.push(`${roleLabel}: ${cleaned}`);
    }
  }
  const priorConversationText = priorLines.join("\n\n");

  const sections: string[] = [];

  if (sanitizedSystem) {
    sections.push(`[시스템 지침]\n${sanitizedSystem}`);
  }

  if (extractedDocs.length > 0) {
    sections.push(`[참조 문서 / 첨부 파일]\n${extractedDocs.join("\n\n")}`);
  }

  if (priorConversationText) {
    sections.push(`[이전 대화]\n${priorConversationText}`);
  }

  if (userQuestion) {
    sections.push(`[사용자 질문]\n${userQuestion}`);
  }

  const prompt = sections.join("\n\n");

  return {
    prompt,
    hasUserContent,
    extractedDocs,
    userQuestion,
  };
}
