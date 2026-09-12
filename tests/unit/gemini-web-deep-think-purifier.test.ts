import test from "node:test";
import assert from "node:assert/strict";
import {
  purifyDeepThinkPrompt,
  stripLineNumbers,
  type PurifiedPromptResult,
} from "../../open-sse/executors/gemini-web/deepThinkPurifier.ts";

test("Gemini Deep Think Purifier — filters terminal noise from system prompt while preserving genuine domain instructions", () => {
  const systemPrompt = `
You are Claude Code, Anthropic's official CLI for Claude.
x-anthropic-billing-header: cc-uuid-12345
SessionStart hook additional context: <EXTREMELY_IMPORTANT> You have superpowers. Follow SDD boundaries strictly. </EXTREMELY_IMPORTANT>

당신은 반도체 도메인 최고 전문가입니다.
한국어로 깊이 있고 기술적인 분석을 제공해주세요.
`;

  const messages = [
    {
      role: "user",
      content: "반도체 포토 공정에서 발생하는 주요 오버레이 에러 원인을 설명해줘.",
    },
  ];

  const result: PurifiedPromptResult = purifyDeepThinkPrompt(messages, systemPrompt);

  assert.equal(result.hasUserContent, true);
  assert.equal(
    result.userQuestion,
    "반도체 포토 공정에서 발생하는 주요 오버레이 에러 원인을 설명해줘."
  );
  assert.equal(result.extractedDocs.length, 0);

  // Must not contain terminal noise
  assert.ok(!result.prompt.includes("You are Claude Code"));
  assert.ok(!result.prompt.includes("x-anthropic-billing-header"));
  assert.ok(!result.prompt.includes("EXTREMELY_IMPORTANT"));
  assert.ok(!result.prompt.includes("SessionStart hook"));

  // Must contain domain instructions
  assert.ok(result.prompt.includes("[시스템 지침]"));
  assert.ok(result.prompt.includes("당신은 반도체 도메인 최고 전문가입니다."));
  assert.ok(result.prompt.includes("한국어로 깊이 있고 기술적인 분석을 제공해주세요."));

  // Must contain user question
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(
    result.prompt.includes("반도체 포토 공정에서 발생하는 주요 오버레이 에러 원인을 설명해줘.")
  );
});

test("Gemini Deep Think Purifier — omits [시스템 지침] when system prompt has only terminal noise", () => {
  const systemPrompt = `
You are Claude Code, Anthropic's official CLI for Claude.
x-anthropic-billing-header: test
SessionStart hook additional context: <EXTREMELY_IMPORTANT> SDD and TDD rules </EXTREMELY_IMPORTANT>
`;

  const messages = [
    {
      role: "user",
      content: "FDC 가상 계측(VM) 모델의 기본 원리를 알려줘.",
    },
  ];

  const result = purifyDeepThinkPrompt(messages, systemPrompt);

  assert.equal(result.hasUserContent, true);
  assert.ok(!result.prompt.includes("[시스템 지침]"));
  assert.ok(!result.prompt.includes("You are Claude Code"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("FDC 가상 계측(VM) 모델의 기본 원리를 알려줘."));
});

test("Gemini Deep Think Purifier — strips <system-reminder> harness boilerplate from user message", () => {
  const userContent = `<system-reminder>
<env>
Working directory: /Users/jihyun.son/github/OmniRoute
Is directory a git repo: Yes
</env>
gitStatus: clean
<total_tokens>15000000 tokens left</total_tokens>
The following skills are available for use with the Skill tool:
- superpowers:brainstorming
- context-mode:ctx-search
</system-reminder>

FDC 센서 데이터의 이상치 탐지 알고리즘을 추천해줘.`;

  const messages = [
    {
      role: "user",
      content: userContent,
    },
  ];

  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "FDC 센서 데이터의 이상치 탐지 알고리즘을 추천해줘.");
  assert.equal(result.extractedDocs.length, 0);
  assert.ok(!result.prompt.includes("<system-reminder>"));
  assert.ok(!result.prompt.includes("gitStatus"));
  assert.ok(!result.prompt.includes("superpowers:brainstorming"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("FDC 센서 데이터의 이상치 탐지 알고리즘을 추천해줘."));
});

test("Gemini Deep Think Purifier — extracts referenced document from inside <system-reminder>", () => {
  const userContent = `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase instructions and guidelines.
Contents of /Users/jihyun.son/.claude/rules/context7.md:
Use Context7 MCP for library queries.
Contents of /Users/jihyun.son/github/OmniRoute/ARCHITECTURE.md:
# Virtual Metrology Architecture
## Data Pipeline
FDC sensor data stream -> Feature store -> LightGBM inference -> Virtual metrology prediction.
# currentDate
Today's date is 2026-09-10.
</system-reminder>

다음은 반도체 제조 공정의 FDC 데이터를 기반으로 VM(Virtual Metrology)의 성능 개선을 위한 프로젝트의 아키텍쳐이다. 아키텍쳐의 완성도를 평가해줘. @ARCHITECTURE.md`;

  const messages = [
    {
      role: "user",
      content: userContent,
    },
  ];

  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(
    result.userQuestion,
    "다음은 반도체 제조 공정의 FDC 데이터를 기반으로 VM(Virtual Metrology)의 성능 개선을 위한 프로젝트의 아키텍쳐이다. 아키텍쳐의 완성도를 평가해줘. @ARCHITECTURE.md"
  );
  assert.equal(result.extractedDocs.length, 1);
  assert.ok(result.extractedDocs[0].includes("Virtual Metrology Architecture"));
  assert.ok(result.extractedDocs[0].includes("LightGBM inference"));

  // Harness context should be stripped
  assert.ok(!result.prompt.includes("Use Context7 MCP"));
  assert.ok(!result.prompt.includes("Codebase instructions and guidelines"));
  assert.ok(!result.prompt.includes("<system-reminder>"));

  // Prompt structure check
  assert.ok(result.prompt.includes("[참조 문서 / 첨부 파일]"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(
    result.prompt.indexOf("[참조 문서 / 첨부 파일]") < result.prompt.indexOf("[사용자 질문]")
  );
});

test("Gemini Deep Think Purifier — extracts markdown code block document attachment from user message", () => {
  const userContent = `다음은 반도체 제조 공정의 FDC 데이터를 기반으로 VM(Virtual Metrology)의 성능 개선을 위한 프로젝트의 아키텍쳐이다. 아키텍쳐의 완성도를 평가해줘. @ARCHITECTURE.md

\`\`\`markdown
# ARCHITECTURE.md
## 1. System Architecture
Kafka Ingestion -> Preprocessing -> Inference Engine
\`\`\``;

  const messages = [
    {
      role: "user",
      content: userContent,
    },
  ];

  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(
    result.userQuestion,
    "다음은 반도체 제조 공정의 FDC 데이터를 기반으로 VM(Virtual Metrology)의 성능 개선을 위한 프로젝트의 아키텍쳐이다. 아키텍쳐의 완성도를 평가해줘. @ARCHITECTURE.md"
  );
  assert.equal(result.extractedDocs.length, 1);
  assert.ok(
    result.extractedDocs[0].includes("Kafka Ingestion -> Preprocessing -> Inference Engine")
  );

  assert.ok(result.prompt.includes("[참조 문서 / 첨부 파일]"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(
    result.prompt.indexOf("[참조 문서 / 첨부 파일]") < result.prompt.indexOf("[사용자 질문]")
  );
});

test("Gemini Deep Think Purifier — extracts <file> attachment and Contents of block from user message", () => {
  const userContent = `아래 아키텍처와 스키마를 검토해줘.

<file path="ARCHITECTURE.md">
# Architecture Spec
Data Flow: A -> B -> C
</file>

Contents of SCHEMA.sql:
CREATE TABLE sensor_readings (id INT, value FLOAT);`;

  const messages = [
    {
      role: "user",
      content: userContent,
    },
  ];

  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "아래 아키텍처와 스키마를 검토해줘.");
  assert.equal(result.extractedDocs.length, 2);
  assert.ok(result.extractedDocs.some((doc) => doc.includes("Data Flow: A -> B -> C")));
  assert.ok(result.extractedDocs.some((doc) => doc.includes("CREATE TABLE sensor_readings")));

  assert.ok(result.prompt.includes("[참조 문서 / 첨부 파일]"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
});

test("Gemini Deep Think Purifier — handles array content blocks ({ type: 'text', text: '...' })", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "안녕하세요! " },
        { type: "text", text: "반도체 에칭 공정 시뮬레이션 모델에 대해 질문이 있습니다." },
      ],
    },
  ];

  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(
    result.userQuestion,
    "안녕하세요! \n\n반도체 에칭 공정 시뮬레이션 모델에 대해 질문이 있습니다."
  );
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("반도체 에칭 공정 시뮬레이션 모델에 대해 질문이 있습니다."));
});

test("Gemini Deep Think Purifier — supports multi-turn conversation with [이전 대화]", () => {
  const messages = [
    { role: "user", content: "반도체 CMP 공정에 대해 알려줘." },
    {
      role: "assistant",
      content: "CMP(Chemical Mechanical Planarization)는 웨이퍼 표면을 평탄화하는 공정입니다.",
    },
    { role: "user", content: "슬러리(Slurry)의 역할은 뭐야?" },
  ];

  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "슬러리(Slurry)의 역할은 뭐야?");
  assert.ok(result.prompt.includes("[이전 대화]"));
  assert.ok(result.prompt.includes("반도체 CMP 공정에 대해 알려줘."));
  assert.ok(result.prompt.includes("CMP(Chemical Mechanical Planarization)"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("슬러리(Slurry)의 역할은 뭐야?"));

  // Verify ordering: [이전 대화] comes before [사용자 질문]
  assert.ok(result.prompt.indexOf("[이전 대화]") < result.prompt.indexOf("[사용자 질문]"));
});

test("Gemini Deep Think Purifier — extracts system message from messages array (role: 'system')", () => {
  const messages = [
    {
      role: "system",
      content: "당신은 반도체 결함 분석 AI입니다. 불량 원인과 개선책을 명확히 제시하세요.",
    },
    { role: "user", content: "브리지 결함이 발생했을 때 점검해야 할 항목은?" },
  ];

  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.ok(result.prompt.includes("[시스템 지침]"));
  assert.ok(result.prompt.includes("당신은 반도체 결함 분석 AI입니다."));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("브리지 결함이 발생했을 때 점검해야 할 항목은?"));
});

test("Gemini Deep Think Purifier — handles empty or whitespace messages gracefully", () => {
  const result1 = purifyDeepThinkPrompt([]);
  assert.equal(result1.hasUserContent, false);
  assert.equal(result1.userQuestion, "");
  assert.equal(result1.extractedDocs.length, 0);
  assert.equal(result1.prompt, "");

  const result2 = purifyDeepThinkPrompt([{ role: "user", content: "   " }]);
  assert.equal(result2.hasUserContent, false);
  assert.equal(result2.userQuestion, "");
  assert.equal(result2.extractedDocs.length, 0);
  assert.equal(result2.prompt, "");
});

test("Gemini Deep Think Purifier — structures system instructions, document attachments, and user question in canonical order", () => {
  const systemPrompt = "전문적이고 객관적인 어조로 답변하십시오.";
  const messages = [
    {
      role: "user",
      content: `아키텍처를 평가해줘. @ARCHITECTURE.md

\`\`\`markdown
# ARCHITECTURE.md
Virtual Metrology Platform Spec
\`\`\``,
    },
  ];

  const result = purifyDeepThinkPrompt(messages, systemPrompt);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.extractedDocs.length, 1);
  assert.equal(result.userQuestion, "아키텍처를 평가해줘. @ARCHITECTURE.md");

  const sysIdx = result.prompt.indexOf("[시스템 지침]");
  const docIdx = result.prompt.indexOf("[참조 문서 / 첨부 파일]");
  const userIdx = result.prompt.indexOf("[사용자 질문]");

  assert.ok(sysIdx !== -1, "Should have [시스템 지침]");
  assert.ok(docIdx !== -1, "Should have [참조 문서 / 첨부 파일]");
  assert.ok(userIdx !== -1, "Should have [사용자 질문]");

  assert.ok(sysIdx < docIdx, "[시스템 지침] must precede [참조 문서 / 첨부 파일]");
  assert.ok(docIdx < userIdx, "[참조 문서 / 첨부 파일] must precede [사용자 질문]");
});

test("Gemini Deep Think Purifier — stripLineNumbers removes line number prefixes from cat -n style output", () => {
  const numbered = [
    "     1\timport { Router } from 'express';",
    "     2\t",
    "     3\tconst router = Router();",
    "   120    return router;",
    "    42  const port = 3000;",
  ].join("\n");

  const stripped = stripLineNumbers(numbered);
  const lines = stripped.split("\n");

  assert.equal(lines[0], "import { Router } from 'express';");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "const router = Router();");
  assert.equal(lines[3], "return router;");
  assert.equal(lines[4], "const port = 3000;");
});

test("Gemini Deep Think Purifier — extracts Read tool outputs, strips line numbers, and labels with [참조 문서: <파일명>]", () => {
  const userContent = `Called the Read tool with the following input: {"file_path":"/Users/jihyun.son/github/OmniRoute/src/server.ts"}
Result of calling the Read tool:
     1\timport express from "express";
     2\t
     3\tconst app = express();
     4\tapp.listen(3000);

이 서버의 리스닝 포트를 8080으로 변경하는 방법을 알려줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "이 서버의 리스닝 포트를 8080으로 변경하는 방법을 알려줘.");
  assert.equal(result.extractedDocs.length, 1);
  assert.ok(result.extractedDocs[0].startsWith("[참조 문서: server.ts]"));
  assert.ok(!result.extractedDocs[0].includes("1\t"));
  assert.ok(result.extractedDocs[0].includes('import express from "express";'));
  assert.ok(result.extractedDocs[0].includes("app.listen(3000);"));

  assert.ok(result.prompt.includes("[참조 문서: server.ts]"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("이 서버의 리스닝 포트를 8080으로 변경하는 방법을 알려줘."));
  assert.ok(!result.prompt.includes("Called the Read tool"));
});

test("Gemini Deep Think Purifier — blocks Read tool output for HARNESS_FILES", () => {
  const userContent = `Called the Read tool with the following input: {"file_path":"/Users/jihyun.son/github/OmniRoute/CLAUDE.md"}
Result of calling the Read tool:
     1\t# CLAUDE.md
     2\t## Hard Rules
     3\tNever commit directly to main

이 프로젝트의 Git 브랜치 전략을 알려줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "이 프로젝트의 Git 브랜치 전략을 알려줘.");
  assert.equal(result.extractedDocs.length, 0);
  assert.ok(!result.prompt.includes("Never commit directly to main"));
  assert.ok(!result.prompt.includes("Called the Read tool"));
  assert.ok(result.prompt.includes("이 프로젝트의 Git 브랜치 전략을 알려줘."));
});

test("Gemini Deep Think Purifier — blocks Contents of blocks with parenthesis explanations matching HARNESS_FILES", () => {
  const userContent = `Contents of /Users/jihyun.son/.claude/rules/context7.md (user's private global instructions for all projects):
Use Context7 MCP whenever the user asks about a library.

Contents of /Users/jihyun.son/github/OmniRoute/CLAUDE.md (project instructions, checked into the codebase):
# CLAUDE.md instructions

Contents of /Users/jihyun.son/github/OmniRoute/SPEC.md (architecture specification):
# High-Level Architecture
Client -> Proxy -> Provider

위 아키텍처 스펙을 검토해줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "위 아키텍처 스펙을 검토해줘.");
  assert.equal(result.extractedDocs.length, 1);
  assert.ok(result.extractedDocs[0].includes("High-Level Architecture"));
  assert.ok(!result.prompt.includes("Use Context7 MCP"));
  assert.ok(!result.prompt.includes("CLAUDE.md instructions"));
  assert.ok(result.prompt.includes("Client -> Proxy -> Provider"));
});

test("Gemini Deep Think Purifier — completely strips CLI harness, superpowers, MCP, and delegation boilerplate from user message", () => {
  const userContent = `# Delegation role definitions
Role terms in this prompt are structural: "root/main session" means the primary conversation.
Only the root/main session coordinates work. Every subagent is a terminal leaf worker.

# 공통 실행 통제 규칙
## Capability와 도구 사용
- capability는 실제 도구 목록에 노출되고 최소 1회 성공 호출됐을 때만 사용했다고 주장.
## Contract와 설계 경계
- 한 task = 하나의 production contract.
## 실행·격리·소유권
- 구현 전 계획·task ownership·baseline 고정.
## 구현·검증·완료
- 실행 근거 없이 완료 선언 금지.

# MCP Server Instructions
The following MCP servers have provided instructions for how to use their tools:
## context7
Use this server to fetch current documentation.
## plugin:context7:context7
Use this server to fetch docs.

# Mandatory Parent Edit Barrier
As the root/main coordinator, you are STRICTLY PROHIBITED from calling Edit or Write.

오늘 날짜 기준 Next.js 16의 새로운 라우팅 기능을 설명해줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "오늘 날짜 기준 Next.js 16의 새로운 라우팅 기능을 설명해줘.");
  assert.equal(result.extractedDocs.length, 0);
  assert.ok(!result.prompt.includes("Delegation role definitions"));
  assert.ok(!result.prompt.includes("공통 실행 통제 규칙"));
  assert.ok(!result.prompt.includes("Capability와 도구 사용"));
  assert.ok(!result.prompt.includes("Contract와 설계 경계"));
  assert.ok(!result.prompt.includes("MCP Server Instructions"));
  assert.ok(!result.prompt.includes("Mandatory Parent Edit Barrier"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("오늘 날짜 기준 Next.js 16의 새로운 라우팅 기능을 설명해줘."));
});

test("Gemini Deep Think Purifier — omits [시스템 지침] when system prompt contains only MCP server instructions and harness noise", () => {
  const systemPrompt = `# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

## context7
Use this server to fetch current documentation whenever the user asks about a library.

## plugin:context7:context7
Use this server to fetch current documentation.

# The Rule
Follow all instructions.
`;

  const messages = [{ role: "user", content: "React 19 Server Actions에 대해 설명해줘." }];
  const result = purifyDeepThinkPrompt(messages, systemPrompt);

  assert.equal(result.hasUserContent, true);
  assert.ok(!result.prompt.includes("[시스템 지침]"));
  assert.ok(!result.prompt.includes("MCP Server Instructions"));
  assert.ok(!result.prompt.includes("The Rule"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("React 19 Server Actions에 대해 설명해줘."));
});

test("Gemini Deep Think Purifier — filters parenthesis explanations from Contents of inside <system-reminder>", () => {
  const userContent = `<system-reminder>
Contents of /Users/jihyun.son/.claude/rules/context7.md (user's private global instructions for all projects):
Use Context7 MCP whenever the user asks about a library.

Contents of /Users/jihyun.son/github/OmniRoute/CLAUDE.md (project instructions, checked into the codebase):
# CLAUDE.md instructions

Contents of /Users/jihyun.son/github/OmniRoute/DESIGN.md (design document):
# System Design Spec
Microservices and event streams
</system-reminder>

시스템 디자인 스펙을 평가해줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "시스템 디자인 스펙을 평가해줘.");
  assert.equal(result.extractedDocs.length, 1);
  assert.ok(result.extractedDocs[0].includes("System Design Spec"));
  assert.ok(result.extractedDocs[0].includes("Microservices and event streams"));
  assert.ok(!result.prompt.includes("Use Context7 MCP"));
  assert.ok(!result.prompt.includes("CLAUDE.md instructions"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("시스템 디자인 스펙을 평가해줘."));
});

test("Gemini Deep Think Purifier — handles multiple Read tool calls and strips all line numbers cleanly", () => {
  const userContent = `Called the Read tool with the following input: {"file_path":"src/a.ts"}
Result of calling the Read tool:
     1	export const a = 1;
     2

Called the Read tool with the following input: {"file_path":"src/b.ts"}
Result of calling the Read tool:
     1	export const b = 2;
     2	export const c = 3;

a.ts와 b.ts의 변수를 확인하고 합산 로직을 작성해줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "a.ts와 b.ts의 변수를 확인하고 합산 로직을 작성해줘.");
  assert.equal(result.extractedDocs.length, 2);
  assert.ok(result.extractedDocs[0].startsWith("[참조 문서: a.ts]"));
  assert.ok(result.extractedDocs[0].includes("export const a = 1;"));
  assert.ok(!result.extractedDocs[0].includes("1\t"));

  assert.ok(result.extractedDocs[1].startsWith("[참조 문서: b.ts]"));
  assert.ok(result.extractedDocs[1].includes("export const b = 2;"));
  assert.ok(result.extractedDocs[1].includes("export const c = 3;"));
  assert.ok(!result.extractedDocs[1].includes("1\t"));

  assert.ok(result.prompt.includes("[참조 문서: a.ts]"));
  assert.ok(result.prompt.includes("[참조 문서: b.ts]"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("a.ts와 b.ts의 변수를 확인하고 합산 로직을 작성해줘."));
});

test("Gemini Deep Think Purifier — reproduces call 1789121142440-672d32: demoted system turn with Read tool truncation and superpowers is not picked as user question", () => {
  const messages0_user = `# Delegation role definitions
Role terms in this prompt are structural: "root/main session" means the primary conversation.

# 공통 실행 통제 규칙
## Capability와 도구 사용
- capability는 실제 도구 목록에 노출되고 최소 1회 성공 호출됐을 때만 사용했다고 주장.

# gitStatus
Current branch: custom-main
Status: clean

Attribution for git commits and pull requests you create from here on:
- End git commit messages with:
Co-Authored-By: Claude Code <noreply@anthropic.com>

다음은 반도체 제조 공정의 FDC 데이터를 기반으로 VM(Virtual Metrology)의 성능 개선을 위한 프로젝트의 아키텍쳐이다. 아키텍쳐의 완성도를 평가해줘.
---
@ARCHITECTURE.md`;

  const messages1_demoted_system = `SessionStart hook additional context: <EXTREMELY_IMPORTANT> You have superpowers: brainstorming, subagent-driven-development. Follow SDD boundaries strictly. </EXTREMELY_IMPORTANT>

Called the Read tool with the following input: {"file_path":"/Users/jihyun.son/github/OmniRoute/ARCHITECTURE.md"}
Result of calling the Read tool:
     1\t# Virtual Metrology Architecture
     2\t
     3\t## 1. Overview
     4\tVirtual Metrology (VM) models semiconductor process results.
     5\t
[...truncated 5217 chars...]
   150\t## 5. Performance Evaluation & Validation
   151\tThe system evaluates RMSE, MAPE, and R2 scores for wafer thickness predictions.
   152\tReal-time inference latency is bounded at 20ms per wafer.

The following skills are available for use with the Skill tool:
- superpowers:brainstorming
- superpowers:subagent-driven-development

Then announce "Using superpowers:brainstorming to evaluate the architecture completeness."
gitStatus: clean
<total_tokens>15000000 tokens left</total_tokens>`;

  const messages = [
    { role: "user", content: messages0_user },
    { role: "user", content: messages1_demoted_system },
  ];

  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);

  // Real user question from messages[0] must be picked, NOT the demoted turn residual
  assert.equal(
    result.userQuestion,
    `다음은 반도체 제조 공정의 FDC 데이터를 기반으로 VM(Virtual Metrology)의 성능 개선을 위한 프로젝트의 아키텍쳐이다. 아키텍쳐의 완성도를 평가해줘.
---
@ARCHITECTURE.md`
  );
  assert.ok(!result.userQuestion.includes("superpowers"));
  assert.ok(!result.userQuestion.includes("brainstorming"));
  assert.ok(!result.userQuestion.includes("Then announce"));

  // Full document must be extracted across the truncation marker
  assert.equal(result.extractedDocs.length, 1);
  assert.ok(result.extractedDocs[0].startsWith("[참조 문서: ARCHITECTURE.md]"));
  assert.ok(
    result.extractedDocs[0].includes("Virtual Metrology (VM) models semiconductor process results.")
  );
  assert.ok(result.extractedDocs[0].includes("[...truncated 5217 chars...]"));
  assert.ok(
    result.extractedDocs[0].includes(
      "The system evaluates RMSE, MAPE, and R2 scores for wafer thickness predictions."
    )
  );
  assert.ok(
    result.extractedDocs[0].includes("Real-time inference latency is bounded at 20ms per wafer.")
  );
  assert.ok(!result.extractedDocs[0].includes("150\t"));

  // Prompt structure verification
  assert.ok(result.prompt.includes("[참조 문서 / 첨부 파일]"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("다음은 반도체 제조 공정의 FDC 데이터를 기반으로 VM"));
  assert.ok(!result.prompt.includes("Using superpowers:brainstorming"));
  assert.ok(!result.prompt.includes("Then announce"));

  // Real question must NOT be relegated to prior turns
  if (result.prompt.includes("[이전 대화]")) {
    assert.ok(
      !result.prompt
        .split("[이전 대화]")[1]
        .split("[사용자 질문]")[0]
        .includes("아키텍쳐의 완성도를 평가해줘.")
    );
  }
});

test("Gemini Deep Think Purifier — preserves numbers in document content while stripping cat -n prefixes", () => {
  const userContent = `Called the Read tool with the following input: {"file_path":"docs/spec.md"}
Result of calling the Read tool:
     1\t# Spec 2026
     2\t1. Introduction: Year 2024 to 2026
     3\t| 1 | Table entry 100 |
     4\t[...truncated 1000 chars...]
     5\tPrice is $500 for 2 items.

스펙 문서를 요약해줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "스펙 문서를 요약해줘.");
  assert.equal(result.extractedDocs.length, 1);
  const doc = result.extractedDocs[0];
  assert.ok(doc.includes("# Spec 2026"));
  assert.ok(doc.includes("1. Introduction: Year 2024 to 2026"));
  assert.ok(doc.includes("| 1 | Table entry 100 |"));
  assert.ok(doc.includes("[...truncated 1000 chars...]"));
  assert.ok(doc.includes("Price is $500 for 2 items."));
});

test("Gemini Deep Think Purifier — reproduces call 1789131870157-9f2db3: client operational harness in system array is stripped and [시스템 지침] is omitted", () => {
  const systemArray = [
    {
      type: "text",
      text: "x-anthropic-billing-header: cc-uuid-9f2db3-4451",
    },
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
    {
      type: "text",
      text: `You are an interactive agent that helps users with software engineering tasks.

Security guidance: Do not assist with cyberattacks or bypass security controls.

Pronouns: The user may refer to you as Claude.

Reversibility: When modifying code, make changes that are easily reversible.

# Session-specific guidance
You are currently in a multi-turn conversation.
Follow the user's instructions carefully.

Do not assume capabilities that are not exposed.

# Memory
You have a persistent file-based memory at /Users/jihyun.son/.claude/projects/-Users-jihyun-son-github-OmniRoute/memory/
Review memory files before performing critical actions.

# Environment
Working directory: /Users/jihyun.son/github/OmniRoute/.claude/worktrees/gemini-web-robust-enhancements
Is directory a git repo: true

# Context management
Keep your context window clean.
Do not read unnecessary files.`,
    },
  ];

  const messages = [
    {
      role: "user",
      content: `다음 아키텍처 스펙을 검토해줘. @SPEC.md

\`\`\`markdown
# SPEC.md
Streaming architecture specification.
\`\`\``,
    },
  ];

  const result = purifyDeepThinkPrompt(messages, systemArray);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "다음 아키텍처 스펙을 검토해줘. @SPEC.md");
  assert.equal(result.extractedDocs.length, 1);
  assert.ok(result.extractedDocs[0].includes("Streaming architecture specification."));

  // [시스템 지침] must be completely omitted because systemArray only contains CLI harness
  assert.ok(!result.prompt.includes("[시스템 지침]"));
  assert.ok(!result.prompt.includes("You are an interactive agent"));
  assert.ok(!result.prompt.includes("Session-specific guidance"));
  assert.ok(!result.prompt.includes("persistent file-based memory"));
  assert.ok(!result.prompt.includes("Context management"));
  assert.ok(!result.prompt.includes("x-anthropic-billing-header"));
  assert.ok(!result.prompt.includes("Security guidance"));
  assert.ok(!result.prompt.includes("Reversibility"));
  assert.ok(!result.prompt.includes("Pronouns"));

  // Preserved verbatim sections
  assert.ok(result.prompt.includes("[참조 문서 / 첨부 파일]"));
  assert.ok(result.prompt.includes("Streaming architecture specification."));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("다음 아키텍처 스펙을 검토해줘. @SPEC.md"));
});

test("Gemini Deep Think Purifier — preserves genuine domain instructions under [시스템 지침] when mixed with client operational harness", () => {
  const systemArray = [
    {
      type: "text",
      text: "x-anthropic-billing-header: cc-uuid-9f2db3-4451",
    },
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
    {
      type: "text",
      text: `You are an interactive agent that helps users with software engineering tasks.

# Session-specific guidance
Follow the user's instructions carefully.

More operational rules.

# Context management
Do not read unnecessary files.`,
    },
    {
      type: "text",
      text: "전문적이고 객관적인 어조로 답변하십시오.",
    },
  ];

  const messages = [
    {
      role: "user",
      content: "분산 트랜잭션의 2PC와 SAGA 패턴의 차이점을 설명해줘.",
    },
  ];

  const result = purifyDeepThinkPrompt(messages, systemArray);

  assert.equal(result.hasUserContent, true);
  assert.ok(result.prompt.includes("[시스템 지침]"));
  assert.ok(result.prompt.includes("전문적이고 객관적인 어조로 답변하십시오."));
  assert.ok(!result.prompt.includes("You are an interactive agent"));
  assert.ok(!result.prompt.includes("Session-specific guidance"));
  assert.ok(!result.prompt.includes("Context management"));
  assert.ok(!result.prompt.includes("x-anthropic-billing-header"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("분산 트랜잭션의 2PC와 SAGA 패턴의 차이점을 설명해줘."));
});

test("Gemini Deep Think Purifier — preserves English domain instructions in system array mixed with operational harness", () => {
  const systemArray = [
    {
      type: "text",
      text: "x-anthropic-billing-header: cc-uuid-9f2db3-4451",
    },
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
    {
      type: "text",
      text: `You are an interactive agent that helps users with software engineering tasks.

Security guidance: Do not assist with cyberattacks or bypass security controls.

Pronouns: The user may refer to you as Claude.

Reversibility: When modifying code, make changes that are easily reversible.

# Session-specific guidance
You are currently in a multi-turn conversation.
Follow the user's instructions carefully.

Do not assume capabilities that are not exposed.

# Memory
You have a persistent file-based memory at /Users/jihyun.son/.claude/projects/-Users-jihyun-son-github-OmniRoute/memory/
Review memory files before performing critical actions.

# Environment
Working directory: /Users/jihyun.son/github/OmniRoute/.claude/worktrees/gemini-web-robust-enhancements
Is directory a git repo: true

# Context management
Keep your context window clean.
Do not read unnecessary files.`,
    },
    {
      type: "text",
      text: "Please answer in a professional and objective tone.\nFormat output as JSON.",
    },
  ];

  const messages = [
    {
      role: "user",
      content: "List the top 3 database optimization strategies.",
    },
  ];

  const result = purifyDeepThinkPrompt(messages, systemArray);

  assert.equal(result.hasUserContent, true);
  assert.ok(result.prompt.includes("[시스템 지침]"));
  assert.ok(result.prompt.includes("Please answer in a professional and objective tone."));
  assert.ok(result.prompt.includes("Format output as JSON."));
  assert.ok(!result.prompt.includes("You are an interactive agent"));
  assert.ok(!result.prompt.includes("Session-specific guidance"));
  assert.ok(!result.prompt.includes("Context management"));
  assert.ok(!result.prompt.includes("persistent file-based memory"));
  assert.ok(!result.prompt.includes("x-anthropic-billing-header"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("List the top 3 database optimization strategies."));
});

test("Gemini Deep Think Purifier — preserves English user question following harness in user turn", () => {
  const userContent = `# Delegation role definitions
Role terms in this prompt are structural: "root/main session" means the primary conversation.
Only the root/main session coordinates work. Every subagent is a terminal leaf worker.

# MCP Server Instructions
The following MCP servers have provided instructions:
## context7
Use this server to fetch current documentation.

# Mandatory Parent Edit Barrier
As the root/main coordinator, you are STRICTLY PROHIBITED from calling Edit or Write.

How do I configure nginx reverse proxy with websockets?`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "How do I configure nginx reverse proxy with websockets?");
  assert.ok(!result.prompt.includes("Delegation role definitions"));
  assert.ok(!result.prompt.includes("MCP Server Instructions"));
  assert.ok(!result.prompt.includes("Mandatory Parent Edit Barrier"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("How do I configure nginx reverse proxy with websockets?"));
});

test("Gemini Deep Think Purifier — reproduces call 1789143735663-262997: unheadered operational harness and memory template leakage is stripped and [시스템 지침] omitted", () => {
  const systemPrompt = `
x-anthropic-billing-header: cc-uuid-262997-8812
You are Claude Code, Anthropic's official CLI for Claude.
You are an interactive agent that helps users with software engineering tasks.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, exploit development, or attacking targets without authorization.

Write code that reads like the surrounding code: match its comment density, naming, and idiom.

When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them unless their name or context clearly indicates otherwise.

For actions that are hard to reverse or outward-facing, confirm first unless durably authorized.

# Session-specific guidance
You are currently in a multi-turn conversation.
Follow the user's instructions carefully.

Do not assume capabilities that are not exposed.

# Memory
You have a persistent file-based memory at /Users/jihyun.son/.claude/projects/-Users-jihyun-son-github-OmniRoute/memory/

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary, used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---
<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>
\`\`\`

In the body, link to related memories with [[name]].
user: who the user is... feedback: guidance... project:... reference:...
After writing the file, add a one-line pointer in MEMORY.md.
Before saving, check for an existing file that already covers it.

# Context management
When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey.
`;

  const messages = [
    {
      role: "user",
      content: "FDC 가상 계측(VM) 모델의 기본 원리를 알려줘.",
    },
  ];

  const result = purifyDeepThinkPrompt(messages, systemPrompt);

  assert.equal(result.hasUserContent, true);
  assert.equal(result.userQuestion, "FDC 가상 계측(VM) 모델의 기본 원리를 알려줘.");
  assert.equal(result.extractedDocs.length, 0);

  // [시스템 지침] must be completely omitted
  assert.ok(!result.prompt.includes("[시스템 지침]"), "Prompt must not contain [시스템 지침]");
  assert.ok(!result.prompt.includes("Assist with authorized security testing"));
  assert.ok(!result.prompt.includes("Write code that reads like the surrounding code"));
  assert.ok(!result.prompt.includes("When you use a pronoun for someone"));
  assert.ok(!result.prompt.includes("For actions that are hard to reverse"));
  assert.ok(!result.prompt.includes("short-kebab-case-slug"));
  assert.ok(!result.prompt.includes("When you have enough information to act, act"));
  assert.ok(!result.prompt.includes("persistent file-based memory"));

  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("FDC 가상 계측(VM) 모델의 기본 원리를 알려줘."));
});

test("Gemini Deep Think Purifier — preserves genuine domain instructions when mixed with unheadered harness and memory template", () => {
  const systemPrompt = `
x-anthropic-billing-header: cc-uuid-262997-8812
You are Claude Code, Anthropic's official CLI for Claude.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, exploit development, or attacking targets without authorization.

Write code that reads like the surrounding code: match its comment density, naming, and idiom.

When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them unless their name or context clearly indicates otherwise.

For actions that are hard to reverse or outward-facing, confirm first unless durably authorized.

# Memory
You have a persistent file-based memory at /Users/jihyun.son/.claude/projects/-Users-jihyun-son-github-OmniRoute/memory/

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary, used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---
<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>
\`\`\`

In the body, link to related memories with [[name]].
user: who the user is... feedback: guidance... project:... reference:...
After writing the file, add a one-line pointer in MEMORY.md.
Before saving, check for an existing file that already covers it.

# Context management
When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey.

당신은 반도체 결함 분석 전문가입니다.
한국어로 핵심 결함 원인과 대책을 요약하십시오.
`;

  const messages = [
    {
      role: "user",
      content: "CMP 디싱(dishing) 결함 원인을 분석해줘.",
    },
  ];

  const result = purifyDeepThinkPrompt(messages, systemPrompt);

  assert.equal(result.hasUserContent, true);
  assert.ok(result.prompt.includes("[시스템 지침]"));
  assert.ok(result.prompt.includes("당신은 반도체 결함 분석 전문가입니다."));
  assert.ok(result.prompt.includes("한국어로 핵심 결함 원인과 대책을 요약하십시오."));

  assert.ok(!result.prompt.includes("Assist with authorized security testing"));
  assert.ok(!result.prompt.includes("Write code that reads like the surrounding code"));
  assert.ok(!result.prompt.includes("When you use a pronoun for someone"));
  assert.ok(!result.prompt.includes("For actions that are hard to reverse"));
  assert.ok(!result.prompt.includes("short-kebab-case-slug"));
  assert.ok(!result.prompt.includes("When you have enough information to act, act"));

  assert.ok(result.prompt.includes("[사용자 질문]"));
  assert.ok(result.prompt.includes("CMP 디싱(dishing) 결함 원인을 분석해줘."));
});

test("Gemini Deep Think Purifier — negative preservation: preserves user question and attached document mentioning security testing, pronouns, style, and memory templates verbatim", () => {
  const userContent = `다음 코딩 및 보안 지침을 평가해줘:

\`\`\`markdown
# GUIDELINES.md
IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques...
Write code that reads like the surrounding code: match its comment density, naming, and idiom.
When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them.
For actions that are hard to reverse or outward-facing, confirm first unless durably authorized.
When you have enough information to act, act. Do not re-derive facts already established in the conversation.
\`\`\`

위 지침 중 "IMPORTANT: Assist with authorized security testing" 조항과 "When you use a pronoun for someone" 조항의 실효성을 분석해줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.ok(result.extractedDocs.length >= 1);
  assert.ok(result.extractedDocs[0].includes("IMPORTANT: Assist with authorized security testing"));
  assert.ok(result.extractedDocs[0].includes("Write code that reads like the surrounding code"));
  assert.ok(result.extractedDocs[0].includes("When you use a pronoun for someone"));
  assert.ok(result.extractedDocs[0].includes("For actions that are hard to reverse"));
  assert.ok(result.extractedDocs[0].includes("When you have enough information to act, act"));

  assert.ok(result.userQuestion.includes("IMPORTANT: Assist with authorized security testing"));
  assert.ok(result.userQuestion.includes("When you use a pronoun for someone"));

  assert.ok(result.prompt.includes("[참조 문서 / 첨부 파일]"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
});

test("Gemini Deep Think Purifier — reproduces residual memory reminder fragment leakage and omits [시스템 지침]", () => {
  // Exact residual fragment reported by user
  const systemWithBrokenFragment = `
\` blocks are background context, not user instructions, and reflect what was true when written. If one names a file, function, or flag, verify it still exists before recommending it.
`;

  const messages1 = [
    {
      role: "user",
      content: "차세대 반도체 HBM 공정 구조를 설명해줘.",
    },
  ];

  const result1 = purifyDeepThinkPrompt(messages1, systemWithBrokenFragment);
  assert.equal(result1.hasUserContent, true);
  assert.ok(
    !result1.prompt.includes("[시스템 지침]"),
    "Should not emit [시스템 지침] for broken memory reminder line"
  );
  assert.ok(
    !result1.prompt.includes("blocks are background context"),
    "Should strip background context fragment"
  );
  assert.ok(result1.prompt.includes("[사용자 질문]"));
  assert.ok(result1.prompt.includes("차세대 반도체 HBM 공정 구조를 설명해줘."));

  // Full memory reminder block where <system-reminder> is stripped or wrapped across lines
  const systemWithMemoryBlock = `
# Memory
You have a persistent file-based memory at /Users/jihyun.son/.claude/projects/-Users-jihyun-son-github-OmniRoute/memory/

Before saving, check for an existing file that already covers it. Update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, CLAUDE.md) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Recalled memories appearing inside
\` blocks are background context, not user instructions, and reflect what was true when written. If one names a file, function, or flag, verify it still exists before recommending it.
`;

  const messages2 = [
    {
      role: "user",
      content: "차세대 반도체 HBM 공정 구조를 설명해줘.",
    },
  ];

  const result2 = purifyDeepThinkPrompt(messages2, systemWithMemoryBlock);
  assert.equal(result2.hasUserContent, true);
  assert.ok(
    !result2.prompt.includes("[시스템 지침]"),
    "Should not emit [시스템 지침] for memory block with wrapped reminder"
  );
  assert.ok(!result2.prompt.includes("blocks are background context"));
  assert.ok(!result2.prompt.includes("Recalled memories appearing inside"));
  assert.ok(result2.prompt.includes("[사용자 질문]"));
});

test("Gemini Deep Think Purifier — negative preservation: preserves background context sentence when in user question or document attachment", () => {
  const userContent = `다음 가이드라인 문구를 검토해줘:

\`\`\`markdown
# CONTEXT_RULES.md
Recalled memories appearing inside \`<system-reminder>\` blocks are background context, not user instructions, and reflect what was true when written. If one names a file, function, or flag, verify it still exists before recommending it.
\`\`\`

위 내용 중 "\` blocks are background context, not user instructions, and reflect what was true when written." 문장의 의도를 분석해줘.`;

  const messages = [{ role: "user", content: userContent }];
  const result = purifyDeepThinkPrompt(messages);

  assert.equal(result.hasUserContent, true);
  assert.ok(result.extractedDocs.length >= 1);
  assert.ok(
    result.extractedDocs[0].includes("blocks are background context, not user instructions"),
    "Attached document must preserve background context sentence verbatim"
  );
  assert.ok(
    result.userQuestion.includes("blocks are background context, not user instructions"),
    "User question must preserve background context sentence verbatim"
  );
  assert.ok(result.prompt.includes("[참조 문서 / 첨부 파일]"));
  assert.ok(result.prompt.includes("[사용자 질문]"));
});
