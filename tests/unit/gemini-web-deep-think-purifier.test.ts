import test from "node:test";
import assert from "node:assert/strict";
import {
  purifyDeepThinkPrompt,
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
    "안녕하세요! 반도체 에칭 공정 시뮬레이션 모델에 대해 질문이 있습니다."
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
