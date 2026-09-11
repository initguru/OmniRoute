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
 * by `cat -n` or Claude Code's Read tool from every line while preserving
 * numbers inside normal text.
 */
export function stripLineNumbers(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t|^\s{2,}\d+\s{2,}|^\s{2,}\d+\s*$/, ""))
    .join("\n");
}

const BOILERPLATE_LINE_PATTERNS: readonly RegExp[] = [
  /^x-anthropic-[a-z0-9-]+:/i,
  /^You are Claude Code/i,
  /^You are a Claude agent/i,
  /^You are an agent for Claude Code/i,
  /^SessionStart\b/i,
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
  /^gitStatus\b/i,
  /^#+ gitStatus/i,
  /^Today's date is/i,
  /^#+ currentDate/i,
  /^Attribution for git commits/i,
  /^Co-Authored-By:/i,
  /^🤖 Generated with/i,
  /^Then announce\b/i,
  /^Using superpowers:/i,
  /^#+ Environment\b/i,
  /^You are powered by the model/i,
  /^You are an interactive agent that helps users with software engineering tasks/i,
  /^#+ Session-specific guidance\b/i,
  /^You have a persistent file-based memory at\b/i,
  /^#+ Context management\b/i,
  /^(?:#+\s*)?Security guidance\b/i,
  /^(?:#+\s*)?Security testing\b/i,
  /^(?:#+\s*)?Pronouns?(?:\s+guidance)?\b/i,
  /^(?:#+\s*)?Reversibility\b/i,
  /^IMPORTANT:\s*Assist with authorized security testing/i,
  /^Write code that reads like the surrounding code/i,
  /^When you use a pronoun for someone/i,
  /^For actions that are hard to reverse/i,
  /^When you have enough information to act,\s*act\b/i,
  /^In the body, link to related memories with\b/i,
  /^After writing the file, add a one-line pointer in MEMORY\.md\b/i,
  /^Before saving, check for an existing file that already covers it\b/i,
  /^(?:user|feedback|project|reference):\s*(?:who the user is|guidance|what the project is|external references)/i,
];

const BOILERPLATE_SECTION_HEADER_PATTERNS: readonly RegExp[] = [
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
  /^#+ gitStatus/i,
  /^#+ currentDate/i,
  /^#+ Environment\b/i,
  /^#+ Session-specific guidance\b/i,
  /^#+ Context management\b/i,
  /^#+ Tone and style\b/i,
  /^(?:#+\s*)?Security guidance\b/i,
  /^(?:#+\s*)?Security testing\b/i,
  /^(?:#+\s*)?Pronouns?(?:\s+guidance)?\b/i,
  /^(?:#+\s*)?Reversibility\b/i,
  /^IMPORTANT:\s*Assist with authorized security testing/i,
  /^Write code that reads like the surrounding code/i,
  /^When you use a pronoun for someone/i,
  /^For actions that are hard to reverse/i,
  /^When you have enough information to act,\s*act\b/i,
  /^You are an interactive agent that helps users with software engineering tasks/i,
  /^You have a persistent file-based memory at\b/i,
  /^Guidelines:\s*$/i,
  /^Your strengths:\s*$/i,
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
  /(?:^|\n)[ \t]*IMPORTANT:\s*Assist with authorized security testing[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*Write code that reads like the surrounding code[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*When you use a pronoun for someone[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*For actions that are hard to reverse[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*When you have enough information to act,\s*act\b[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*Attribution for git commits and pull requests[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n\n(?![ \t]*(?:-|\s*$))[가-힣A-Za-z0-9]|$))/gi,
  /(?:^|\n)[ \t]*SessionStart(?: hook)?[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*Called the |\n\n(?![ \t]*(?:<|-|\s*$))[가-힣A-Za-z0-9]|$))/gi,
  /(?:^|\n)[ \t]*The following skills are available[\s\S]*?(?=(?:\n\n(?![ \t]*-)[가-힣A-Za-z0-9])|\n[ \t]*# |$)/gi,
  /(?:^|\n)[ \t]*Then announce\s+["']Using[\s\S]*?(?=(?:\n\n[가-힣A-Za-z0-9])|\n[ \t]*# |$)/gi,
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
  /(?:^|\n)[ \t]*#+\s*Memory\b[\s\S]*?(?:Before saving, check for an existing file[^\n]*|Review memory files[^\n]*|(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<(?:system-reminder|env|context|total_tokens)|$)))/gi,
  /(?:^|\n)[ \t]*You have a persistent file-based memory at\b[\s\S]*?(?:Before saving, check for an existing file[^\n]*|Review memory files[^\n]*|(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<(?:system-reminder|env|context|total_tokens)|$)))/gi,
  /(?:^|\n)[ \t]*```markdown\s*\n---\s*\nname:\s*<short-kebab-case-slug>[\s\S]*?```/gi,
  /(?:^|\n)[ \t]*#+\s*Superpowers\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Available agent types\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*Available agent types:[\s\S]*?(?=(?:\n\n[A-Za-z0-9#가-힣])|$)/gi,
  /(?:^|\n)[ \t]*#+\s*gitStatus[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:##|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*gitStatus:[\s\S]*?(?=(?:\n\n[가-힣A-Za-z0-9])|$)/gi,
  /(?:^|\n)[ \t]*(?:#+\s*currentDate\s*\n)?Today's date is \d{4}-\d{2}-\d{2}\.?[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*#+\s*currentDate[\s\S]*?(?=(?:\n[ \t]*#(?!#) |$))/gi,
  /(?:^|\n)[ \t]*(?:#+\s*)?The Rule\b[^\n]*\n([\s\S]*?)(?=(?:\n[ \t]*#(?!#) |\n\n[A-Za-z0-9#가-힣]|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Environment\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n\n[가-힣A-Z][^\n]*(?:[?.!]|해줘|해주세요|알려줘|바랍니다|설명해줘)|$))/gi,
  /In this environment you have access to a set of tools[\s\S]*?(?=(?:\n\n[A-Za-z0-9#가-힣])|$)/gi,
  /Guidelines:\s*\n(?:[ \t]*-[^\n]*\n?)+/gi,
  /Your strengths:\s*\n(?:[ \t]*-[^\n]*\n?)+/gi,
  /(?:^|\n)[ \t]*You are an interactive agent that helps users with software engineering tasks[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:Security|Pronouns?|Reversibility|Guidelines|Your strengths|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Session-specific guidance\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:You are|Follow|Do not|Review|Capabilities|Instructions|Guidelines|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*#+\s*Context management\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<(?:system-reminder|env|context|total_tokens)|\n\n(?=[가-힣A-Z][^\n]*(?:[?.!]|해줘|해주세요|알려줘|바랍니다|설명해줘|전문적|당신은|Please|Format|Output|You are an expert))|$))/gi,
  /(?:^|\n)[ \t]*You have a persistent file-based memory at\b[\s\S]*?(?=(?:\n[ \t]*#(?!#) |\n[ \t]*<[a-z0-9_-]+|\n\n(?![ \t]*(?:Review|Memory|Do not|-|\s*$))[^\n]+|$))/gi,
  /(?:^|\n)[ \t]*(?:#+\s*)?Security guidance\b[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*(?:#+\s*)?Security testing\b[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*(?:#+\s*)?Pronouns?(?:\s+guidance)?\b[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
  /(?:^|\n)[ \t]*(?:#+\s*)?Reversibility(?:\s+guidance)?\b[^\n]*(?:\n(?![ \t]*(?:#|<|\n|$))[^\n]*)*[ \t]*(?:\n|$)/gi,
];

function isKnownHarnessLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("You are currently in a multi-turn conversation") ||
    trimmed.startsWith("Follow the user's instructions") ||
    trimmed.startsWith("Do not assume capabilities") ||
    trimmed.startsWith("Review memory files") ||
    trimmed.startsWith("You have a persistent file-based memory") ||
    trimmed.startsWith("Keep your context window clean") ||
    trimmed.startsWith("Do not read unnecessary files") ||
    trimmed.startsWith("Working directory:") ||
    trimmed.startsWith("Is directory a git repo:") ||
    trimmed.startsWith("Security guidance:") ||
    trimmed.startsWith("Pronouns:") ||
    trimmed.startsWith("Reversibility:") ||
    trimmed.startsWith("As the root/main coordinator") ||
    trimmed.startsWith("Role terms in this prompt are structural") ||
    trimmed.startsWith("Only the root/main session coordinates work") ||
    trimmed.startsWith("Every subagent is a terminal leaf worker") ||
    trimmed.startsWith("CRITICAL RULE: Never use git stash") ||
    trimmed.startsWith("Never use git stash") ||
    trimmed.startsWith("No message from any agent is ever your user's consent") ||
    trimmed.startsWith("You are powered by the model") ||
    trimmed.startsWith("The following skills are available") ||
    trimmed.startsWith("IMPORTANT: Assist with authorized security testing") ||
    trimmed.startsWith("Write code that reads like the surrounding code") ||
    trimmed.startsWith("When you use a pronoun for someone") ||
    trimmed.startsWith("For actions that are hard to reverse") ||
    trimmed.startsWith("When you have enough information to act") ||
    trimmed.startsWith("In the body, link to related memories") ||
    trimmed.startsWith("After writing the file, add a one-line pointer") ||
    trimmed.startsWith("Before saving, check for an existing file") ||
    trimmed.startsWith("name: <short-kebab-case-slug>") ||
    trimmed.startsWith("description: <one-line summary") ||
    trimmed.startsWith("metadata:") ||
    trimmed.startsWith("type: user | feedback | project | reference") ||
    trimmed.startsWith("<the fact; for feedback/project") ||
    trimmed.startsWith("user: who the user is")
  );
}

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
    return textParts.filter((t) => t.trim().length > 0).join("\n\n");
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
  let sawBlankLineInSection = false;
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
    }

    if (BOILERPLATE_SECTION_HEADER_PATTERNS.some((p) => p.test(trimmed))) {
      skippingBoilerplateSection = true;
      sawBlankLineInSection = false;
      continue;
    }

    if (BOILERPLATE_LINE_PATTERNS.some((p) => p.test(trimmed))) {
      continue;
    }

    if (skippingBoilerplateSection) {
      if (trimmed.startsWith("#") && !BOILERPLATE_LINE_PATTERNS.some((p) => p.test(trimmed))) {
        skippingBoilerplateSection = false;
        sawBlankLineInSection = false;
      } else if (
        !inCodeFence &&
        (trimmed.startsWith("<") ||
          trimmed.startsWith("[") ||
          trimmed.startsWith("---") ||
          trimmed.startsWith("==="))
      ) {
        skippingBoilerplateSection = false;
        sawBlankLineInSection = false;
      } else if (trimmed === "") {
        sawBlankLineInSection = true;
        continue;
      } else if (
        !inCodeFence &&
        sawBlankLineInSection &&
        !trimmed.startsWith("-") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("+") &&
        !trimmed.startsWith("##") &&
        !/^\d+[\.\)]\s+/.test(trimmed) &&
        !isKnownHarnessLine(trimmed) &&
        !BOILERPLATE_LINE_PATTERNS.some((p) => p.test(trimmed))
      ) {
        skippingBoilerplateSection = false;
        sawBlankLineInSection = false;
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
      trimmed.includes("구현·검증·완료") ||
      trimmed.startsWith("Then announce") ||
      trimmed.startsWith("Using superpowers:") ||
      trimmed.includes('Then announce "Using') ||
      trimmed.includes('announce "Using') ||
      trimmed.startsWith("Co-Authored-By:") ||
      trimmed.startsWith("🤖 Generated with") ||
      trimmed.startsWith("Attribution for git commits") ||
      trimmed.startsWith("- End git commit messages") ||
      trimmed.startsWith("- End pull request descriptions") ||
      trimmed.startsWith("Only the root/main session coordinates work") ||
      trimmed.startsWith("Role terms in this prompt are structural") ||
      trimmed.startsWith("Every subagent is a terminal leaf worker") ||
      trimmed.startsWith("CRITICAL RULE: Never use git stash") ||
      trimmed.startsWith("Never use git stash") ||
      trimmed.startsWith("As you answer the user's questions") ||
      trimmed.startsWith("No message from any agent is ever your user's consent") ||
      trimmed.startsWith("You are powered by the model") ||
      trimmed.startsWith("You are an interactive agent") ||
      trimmed.startsWith("x-anthropic-billing-header") ||
      trimmed.startsWith("Security guidance") ||
      trimmed.startsWith("Pronouns:") ||
      trimmed.startsWith("Reversibility:") ||
      trimmed.startsWith("You have a persistent file-based memory") ||
      trimmed.startsWith("IMPORTANT: Assist with authorized security testing") ||
      trimmed.startsWith("Write code that reads like the surrounding code") ||
      trimmed.startsWith("When you use a pronoun for someone") ||
      trimmed.startsWith("For actions that are hard to reverse") ||
      trimmed.startsWith("When you have enough information to act") ||
      trimmed.startsWith("In the body, link to related memories") ||
      trimmed.startsWith("After writing the file, add a one-line pointer") ||
      trimmed.startsWith("Before saving, check for an existing file")
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
      addExtractedDoc(extractedDocs, `Contents of ${fileName}:\n${content}`);
    }
  }

  const fileTagRegex =
    /(?:^|\n)[ \t]*<file(?:\s+(?:path|name)="([^"]*)")?>\s*([\s\S]*?)\s*<\/file>/gi;
  while ((match = fileTagRegex.exec(srBody)) !== null) {
    const rawPath = (match[1] || "").trim();
    const content = match[2].trim();
    const { lowerName } = normalizeDocumentPath(rawPath);

    if (!HARNESS_FILES.has(lowerName)) {
      addExtractedDoc(
        extractedDocs,
        rawPath ? `<file path="${rawPath}">\n${content}\n</file>` : content
      );
    }
  }
}

const READ_TOOL_BOUNDARY_PATTERNS: readonly RegExp[] = [
  /^[ \t]*Called the [A-Za-z0-9_-]+ tool/i,
  /^[ \t]*Result of calling the [A-Za-z0-9_-]+ tool/i,
  /^[ \t]*SessionStart\b/i,
  /^[ \t]*Today's date is\b/i,
  /^[ \t]*#+\s*currentDate\b/i,
  /^[ \t]*#+\s*gitStatus\b/i,
  /^[ \t]*gitStatus:\b/i,
  /^[ \t]*#+\s*Delegation\b/i,
  /^[ \t]*#+\s*공통 실행 통제 규칙\b/i,
  /^[ \t]*#+\s*Mandatory Parent Edit Barrier\b/i,
  /^[ \t]*#+\s*Zero Direct Source Edit Policy\b/i,
  /^[ \t]*#+\s*File-edit tool reliability\b/i,
  /^[ \t]*#+\s*Tool-call declaration\b/i,
  /^[ \t]*#+\s*Claude Code overlay\b/i,
  /^[ \t]*#+\s*Root-only delegation boundary\b/i,
  /^[ \t]*#+\s*MCP Server Instructions\b/i,
  /^[ \t]*#+\s*(?:CLI )?Harness\b/i,
  /^[ \t]*#+\s*Memory\b/i,
  /^[ \t]*#+\s*Superpowers\b/i,
  /^[ \t]*#+\s*Available agent types\b/i,
  /^[ \t]*Available agent types:/i,
  /^[ \t]*The following skills are available\b/i,
  /^[ \t]*You have superpowers\b/i,
  /^[ \t]*Then announce\b/i,
  /^[ \t]*You are (?:Claude|an? agent)\b/i,
  /^[ \t]*In this environment you have access\b/i,
  /^[ \t]*Guidelines:\b/i,
  /^[ \t]*Your strengths:\b/i,
  /^[ \t]*x-anthropic-[a-z0-9-]+:/i,
  /^[ \t]*Attribution for git commits/i,
  /^[ \t]*<system-reminder>/i,
  /^[ \t]*<env>/i,
  /^[ \t]*<context_window_protection>/i,
  /^[ \t]*<deferred_tool_bootstrap>/i,
  /^[ \t]*<tool_selection_hierarchy>/i,
  /^[ \t]*<total_tokens>/i,
  /^[ \t]*\[(?:사용자 질문|시스템 지침|참조 문서|이전 대화)\]/,
];

function isLineNumbered(line: string): boolean {
  return /^\s*\d+(?:\t|[ ]{1,4}|$)/.test(line);
}

function isTruncationMarker(line: string): boolean {
  return /^\[\.\.\..*?\.\.\.\]/.test(line.trim());
}

function isReadBoundary(line: string): boolean {
  const trimmed = line.trim();
  return READ_TOOL_BOUNDARY_PATTERNS.some((p) => p.test(trimmed));
}

function scanReadBlock(lines: string[]): {
  outputLines: string[];
  consumedLines: number;
} {
  const outputLines: string[] = [];
  let consumedLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isReadBoundary(line)) {
      break;
    }

    if (isLineNumbered(line) || isTruncationMarker(line)) {
      outputLines.push(line);
      consumedLines = i + 1;
      continue;
    }

    // Unnumbered or empty line: check if there are subsequent numbered or truncation lines before boundary
    let hasMoreNumbered = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (isReadBoundary(lines[j])) break;
      if (isLineNumbered(lines[j]) || isTruncationMarker(lines[j])) {
        hasMoreNumbered = true;
        break;
      }
    }

    if (hasMoreNumbered) {
      outputLines.push(line);
      consumedLines = i + 1;
    } else {
      break;
    }
  }

  return { outputLines, consumedLines };
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
    const { outputLines, consumedLines } = scanReadBlock(lines);

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
    const { outputLines, consumedLines } = scanReadBlock(lines);

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

function addExtractedDoc(extractedDocs: string[], doc: string): void {
  const trimmed = doc.trim();
  if (!trimmed) return;
  if (!extractedDocs.includes(trimmed)) {
    extractedDocs.push(trimmed);
  }
}

export function extractProtectedDocuments(rawText: string, extractedDocs: string[]): string {
  let text = rawText;

  // 1. Extract docs from <system-reminder> blocks
  const systemReminderRegex = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi;
  let srMatch: RegExpExecArray | null;
  while ((srMatch = systemReminderRegex.exec(text)) !== null) {
    const srBody = srMatch[1];
    extractDocsFromSystemReminder(srBody, extractedDocs);
  }

  // Remove <system-reminder> and common wrapper tags
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "\n");
  text = text.replace(/<\/?system-reminder>/gi, "\n");
  text = text.replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, "");
  text = text.replace(/<env>[\s\S]*?<\/env>/gi, "");

  // 2. Parse and extract Read tool calls
  const { cleanedText: textAfterRead, readDocs } = extractReadToolOutputs(text);
  text = textAfterRead;
  for (const doc of readDocs) {
    addExtractedDoc(extractedDocs, doc);
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
        addExtractedDoc(extractedDocs, docHeader);
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
        addExtractedDoc(extractedDocs, `Contents of ${fileName}:\n${content.trim()}`);
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
        addExtractedDoc(extractedDocs, `--- ${fileName} ---\n${content.trim()}`);
      }
      return "\n";
    }
  );

  return text;
}

function processUserMessage(rawText: string, extractedDocs: string[]): { userQuestion: string } {
  let text = extractProtectedDocuments(rawText, extractedDocs);

  // 6. Extract markdown code blocks (from user question attachments)
  text = text.replace(
    /(?:^|\n)[ \t]*(`{3,})([^\n]*)\n([\s\S]*?)\n[ \t]*\1(?:\n|$)/g,
    (_match, fence, lang, code) => {
      addExtractedDoc(extractedDocs, `${fence}${lang}\n${code}\n${fence}`);
      return "\n";
    }
  );

  // 7. Strip all CLI harness / MCP / Superpowers / delegation boilerplate from remaining text
  text = stripHarnessBoilerplate(text);

  const userQuestion = text.trim();
  return { userQuestion };
}

function isDemotedOrHarnessTurn(rawText: string, cleanedQuestion: string): boolean {
  const trimmedRaw = rawText.trim();
  if (/^SessionStart\b/i.test(trimmedRaw)) return true;
  if (/^Called the [A-Za-z0-9_-]+ tool/i.test(trimmedRaw)) return true;
  if (/^Result of calling the [A-Za-z0-9_-]+ tool/i.test(trimmedRaw)) return true;
  if (
    /^#+\s*(?:Delegation|공통 실행 통제 규칙|Mandatory Parent Edit Barrier|Zero Direct Source Edit Policy|File-edit tool reliability|Tool-call declaration|Claude Code overlay|Root-only delegation boundary|MCP Server Instructions|Superpowers|Memory)\b/i.test(
      trimmedRaw
    )
  ) {
    if (!cleanedQuestion) return true;
  }
  if (!cleanedQuestion) return true;
  return false;
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
  const extractedDocs: string[] = [];
  const systemParts: string[] = [];

  function processSystemItem(item: unknown): void {
    const text = extractMessageText(item);
    if (!text.trim()) return;
    const cleanedSys = extractProtectedDocuments(text, extractedDocs);
    if (!cleanedSys.trim()) return;
    const sanitized = sanitizeSystemPrompt(cleanedSys);
    if (sanitized.trim()) {
      systemParts.push(sanitized.trim());
    }
  }

  if (system) {
    if (Array.isArray(system)) {
      for (const item of system) {
        processSystemItem(item);
      }
    } else {
      processSystemItem(system);
    }
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          processSystemItem(item);
        }
      } else {
        processSystemItem(msg.content);
      }
    }
  }

  const sanitizedSystem = systemParts.join("\n\n");

  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const textMessages = nonSystemMessages.map((m) => ({
    role: m.role,
    content: extractMessageText(m.content),
  }));

  // Extract docs from all non-system turns first
  for (const tm of textMessages) {
    extractProtectedDocuments(tm.content, extractedDocs);
  }

  // Find user turns and evaluate their genuine content
  interface UserTurnInfo {
    idx: number;
    raw: string;
    cleaned: string;
    isDemoted: boolean;
    localDocs: string[];
  }

  const userTurns: UserTurnInfo[] = [];
  for (let i = 0; i < textMessages.length; i++) {
    if (textMessages[i].role === "user") {
      const raw = textMessages[i].content;
      const localDocs: string[] = [];
      const { userQuestion } = processUserMessage(raw, localDocs);
      const isDemoted = isDemotedOrHarnessTurn(raw, userQuestion);
      userTurns.push({ idx: i, raw, cleaned: userQuestion, isDemoted, localDocs });
    }
  }

  if (userTurns.length === 0) {
    const hasUserContent = extractedDocs.length > 0;
    const prompt = hasUserContent ? `[참조 문서 / 첨부 파일]\n${extractedDocs.join("\n\n")}` : "";
    return {
      prompt,
      hasUserContent,
      extractedDocs,
      userQuestion: "",
    };
  }

  // Pick the last genuine user turn (not demoted / harness)
  let chosenTurn: UserTurnInfo | null = null;
  for (let i = userTurns.length - 1; i >= 0; i--) {
    if (!userTurns[i].isDemoted) {
      chosenTurn = userTurns[i];
      break;
    }
  }

  // Fallback to the last user turn if all were classified as demoted/harness
  if (!chosenTurn) {
    chosenTurn = userTurns[userTurns.length - 1];
  }

  // Add any code block docs extracted from the chosen user question
  for (const d of chosenTurn.localDocs) {
    addExtractedDoc(extractedDocs, d);
  }

  const userQuestion = chosenTurn.cleaned;
  const lastUserIdx = chosenTurn.idx;

  const hasUserContent = Boolean(userQuestion.trim() || extractedDocs.length > 0);
  if (!hasUserContent) {
    return {
      prompt: "",
      hasUserContent: false,
      extractedDocs: [],
      userQuestion: "",
    };
  }

  // Prior turns: only turns before lastUserIdx
  const priorTurns = textMessages.filter(
    (m, i) => i < lastUserIdx && (m.role === "user" || m.role === "assistant")
  );

  const priorLines: string[] = [];
  for (const turn of priorTurns) {
    if (turn.role === "user") {
      const localDocs: string[] = [];
      const { userQuestion: cleaned } = processUserMessage(turn.content, localDocs);
      if (isDemotedOrHarnessTurn(turn.content, cleaned)) {
        continue;
      }
      priorLines.push(`User: ${cleaned}`);
    } else {
      const cleaned = sanitizeTurnText(turn.content);
      if (cleaned) {
        priorLines.push(`Assistant: ${cleaned}`);
      }
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
