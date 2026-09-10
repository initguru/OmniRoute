/**
 * Context purifier for Gemini Web Deep Think.
 *
 * Strips CLI terminal boilerplate, hook instructions, and harness headers
 * (e.g. SessionStart hook, <EXTREMELY_IMPORTANT>, x-anthropic-billing-header,
 * <system-reminder> blocks) while preserving user-referenced documents and
 * genuine domain instructions, prominently anchoring the core user question.
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

const BOILERPLATE_LINE_PATTERNS: readonly RegExp[] = [
  /^x-anthropic-[a-z0-9-]+:/i,
  /^You are Claude Code/i,
  /^You are a Claude agent/i,
  /^You are an agent for Claude Code/i,
  /^SessionStart hook additional context:/i,
  /^# Mandatory Parent Edit Barrier/i,
  /^# Zero Direct Source Edit Policy/i,
  /^# File-edit tool reliability/i,
  /^# Tool-call declaration/i,
  /^# Delegation role definitions/i,
  /^# 공통 실행 통제 규칙/i,
  /^# Claude Code overlay/i,
  /^# Root-only delegation boundary/i,
  /^gitStatus:/i,
];

const BOILERPLATE_BLOCK_PATTERNS: readonly RegExp[] = [
  /<EXTREMELY_IMPORTANT>[\s\S]*?<\/EXTREMELY_IMPORTANT>/gi,
  /<context_window_protection>[\s\S]*?<\/context_window_protection>/gi,
  /<deferred_tool_bootstrap>[\s\S]*?<\/deferred_tool_bootstrap>/gi,
  /<tool_selection_hierarchy>[\s\S]*?<\/tool_selection_hierarchy>/gi,
  /<session_continuity>[\s\S]*?<\/session_continuity>/gi,
  /<env>[\s\S]*?<\/env>/gi,
  /<total_tokens>[\s\S]*?<\/total_tokens>/gi,
  /The following skills are available for use with the Skill tool:[\s\S]*?(?=(?:\n\n[A-Za-z0-9#])|$)/gi,
  /In this environment you have access to a set of tools[\s\S]*?(?=(?:\n\n[A-Za-z0-9#])|$)/gi,
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

export function sanitizeSystemPrompt(raw: string): string {
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
      }
      continue;
    }

    if (
      trimmed.includes("You have superpowers") ||
      trimmed.includes("SDD boundaries") ||
      trimmed.includes("feature-dev boundaries")
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

function extractDocsFromSystemReminder(
  srBody: string,
  userTextWithoutReminders: string,
  extractedDocs: string[]
): void {
  const contentsOfRegex =
    /(?:^|\n)[ \t]*Contents of ([^\n:]+):\s*\n([\s\S]*?)(?=(?:\n[ \t]*Contents of |\n[ \t]*# |\n[ \t]*<[a-z0-9_-]+|$))/gi;
  let match: RegExpExecArray | null;

  while ((match = contentsOfRegex.exec(srBody)) !== null) {
    const rawPath = match[1].trim();
    const content = match[2].trim();
    const fileName = rawPath.split("/").pop() || rawPath;
    const lowerName = fileName.toLowerCase();

    const userMentions =
      userTextWithoutReminders.includes(`@${fileName}`) ||
      userTextWithoutReminders.toLowerCase().includes(`@${lowerName}`) ||
      userTextWithoutReminders.includes(fileName);

    if (userMentions || !HARNESS_FILES.has(lowerName)) {
      extractedDocs.push(`Contents of ${fileName}:\n${content}`);
    }
  }

  const fileTagRegex =
    /(?:^|\n)[ \t]*<file(?:\s+(?:path|name)="([^"]*)")?>\s*([\s\S]*?)\s*<\/file>/gi;
  while ((match = fileTagRegex.exec(srBody)) !== null) {
    const rawPath = (match[1] || "").trim();
    const content = match[2].trim();
    const fileName = rawPath.split("/").pop() || rawPath;
    const lowerName = fileName.toLowerCase();

    const userMentions =
      !rawPath ||
      userTextWithoutReminders.includes(`@${fileName}`) ||
      userTextWithoutReminders.toLowerCase().includes(`@${lowerName}`) ||
      userTextWithoutReminders.includes(fileName);

    if (userMentions || !HARNESS_FILES.has(lowerName)) {
      extractedDocs.push(rawPath ? `<file path="${rawPath}">\n${content}\n</file>` : content);
    }
  }
}

function processUserMessage(rawText: string): { userQuestion: string; extractedDocs: string[] } {
  let text = rawText;
  const extractedDocs: string[] = [];

  const textWithoutReminders = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");

  const systemReminderRegex = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi;
  let srMatch: RegExpExecArray | null;
  while ((srMatch = systemReminderRegex.exec(text)) !== null) {
    const srBody = srMatch[1];
    extractDocsFromSystemReminder(srBody, textWithoutReminders, extractedDocs);
  }

  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  text = text.replace(/<\/?system-reminder>/gi, "");
  text = text.replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, "");
  text = text.replace(/<env>[\s\S]*?<\/env>/gi, "");

  text = text.replace(
    /(?:^|\n)[ \t]*<file(?:\s+(?:path|name)="([^"]*)")?>\s*([\s\S]*?)\s*<\/file>(?:\n|$)/gi,
    (_match, path, content) => {
      const docHeader = path ? `<file path="${path}">\n${content.trim()}\n</file>` : content.trim();
      extractedDocs.push(docHeader);
      return "\n";
    }
  );

  text = text.replace(
    /(?:^|\n)[ \t]*Contents of ([^\n:]+):\s*\n([\s\S]*?)(?=(?:\n[ \t]*Contents of |\n[ \t]*<file|\n[ \t]*`{3,}|$))/gi,
    (_match, path, content) => {
      const trimmedPath = path.trim();
      const fileName = trimmedPath.split("/").pop() || trimmedPath;
      extractedDocs.push(`Contents of ${fileName}:\n${content.trim()}`);
      return "\n";
    }
  );

  text = text.replace(
    /(?:^|\n)[ \t]*---+[ \t]*([^\n]+?)[ \t]*---+[ \t]*\n([\s\S]*?)(?:\n[ \t]*---+[ \t]*|$)/gi,
    (_match, name, content) => {
      extractedDocs.push(`--- ${name.trim()} ---\n${content.trim()}`);
      return "\n";
    }
  );

  text = text.replace(
    /(?:^|\n)[ \t]*(`{3,})([^\n]*)\n([\s\S]*?)\n[ \t]*\1(?:\n|$)/g,
    (_match, fence, lang, code) => {
      extractedDocs.push(`${fence}${lang}\n${code}\n${fence}`);
      return "\n";
    }
  );

  const userQuestion = text.trim();
  return { userQuestion, extractedDocs };
}

function sanitizeTurnText(text: string): string {
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  cleaned = cleaned.replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, "");
  cleaned = cleaned.replace(/<env>[\s\S]*?<\/env>/gi, "");
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
