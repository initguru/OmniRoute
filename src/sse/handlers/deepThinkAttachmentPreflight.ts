import crypto from "node:crypto";
import {
  analyzeAttachmentPreflight,
  type SyntheticToolCall,
  type ResolvedFileDocument,
} from "@omniroute/open-sse/executors/gemini-web/attachmentPreflight.ts";
import { isDeepThinkModel } from "@omniroute/open-sse/executors/gemini-web.ts";
import { synthesizeOpenAiSseFromJson } from "@omniroute/open-sse/utils/jsonToSse.ts";

export interface DeepThinkPreflightParams {
  body: Record<string, unknown>;
  provider: string;
  model: string;
  sourceFormat?: string;
  endpoint?: string;
  stream?: boolean;
  headers?: Record<string, string>;
  runtimeOptions?: Record<string, unknown>;
  apiKeyInfo?: unknown;
}

export interface DeepThinkPreflightResult {
  handled: boolean;
  response?: Response;
  readyDocuments?: ResolvedFileDocument[];
  genuineUserTurnIndex?: number;
  genuineUserText?: string;
}

function buildClaudeNonStreamingToolUseResponse(
  toolCalls: SyntheticToolCall[],
  model: string
): Response {
  const msgId = `msg_dt_preflight_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const payload = {
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content: toolCalls.map((tc) => ({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.args,
    })),
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function buildClaudeStreamingToolUseResponse(
  toolCalls: SyntheticToolCall[],
  model: string
): Response {
  const msgId = `msg_dt_preflight_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  let sseOutput = "";

  sseOutput += `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`;

  toolCalls.forEach((tc, index) => {
    sseOutput += `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: {},
      },
    })}\n\n`;

    sseOutput += `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(tc.args),
      },
    })}\n\n`;

    sseOutput += `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index,
    })}\n\n`;
  });

  sseOutput += `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: {
      stop_reason: "tool_use",
      stop_sequence: null,
    },
    usage: { output_tokens: 0 },
  })}\n\n`;

  sseOutput += `event: message_stop\ndata: ${JSON.stringify({
    type: "message_stop",
  })}\n\n`;

  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseOutput));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    }
  );
}

function buildClaudeErrorResponse(errorText: string, model: string, stream: boolean): Response {
  const msgId = `msg_dt_err_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  if (!stream) {
    const payload = {
      id: msgId,
      type: "message",
      role: "assistant",
      model,
      content: [
        {
          type: "text",
          text: errorText,
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  let sseOutput = "";
  sseOutput += `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`;

  sseOutput += `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "text",
      text: "",
    },
  })}\n\n`;

  sseOutput += `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: {
      type: "text_delta",
      text: errorText,
    },
  })}\n\n`;

  sseOutput += `event: content_block_stop\ndata: ${JSON.stringify({
    type: "content_block_stop",
    index: 0,
  })}\n\n`;

  sseOutput += `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: {
      stop_reason: "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 0 },
  })}\n\n`;

  sseOutput += `event: message_stop\ndata: ${JSON.stringify({
    type: "message_stop",
  })}\n\n`;

  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseOutput));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    }
  );
}

function buildOpenAiToolUseResponse(
  toolCalls: SyntheticToolCall[],
  model: string,
  stream: boolean
): Response {
  const cid = `chatcmpl-dt-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const payload = {
    id: cid,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  if (!stream) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sse = synthesizeOpenAiSseFromJson(JSON.stringify(payload));
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    }
  );
}

function buildOpenAiErrorResponse(errorText: string, model: string, stream: boolean): Response {
  const cid = `chatcmpl-dt-err-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const payload = {
    id: cid,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: errorText,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  if (!stream) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sse = synthesizeOpenAiSseFromJson(JSON.stringify(payload));
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    }
  );
}

/**
 * Interceptor for Gemini Deep Think @file attachment preflight loop.
 * Detects unresolved @file references in user question, issues synthetic client Read tool calls,
 * verifies client tool_results, or cleanly halts on missing/failed file reads without calling upstream.
 */
export async function handleDeepThinkAttachmentPreflight(
  params: DeepThinkPreflightParams
): Promise<DeepThinkPreflightResult> {
  const { provider, model, body, endpoint = "", sourceFormat = "", stream = false } = params;

  if (provider !== "gemini-web" || !isDeepThinkModel(model)) {
    return { handled: false };
  }

  // Determine client API format
  let clientFormat: "claude" | "openai" | null = null;
  if (
    endpoint.includes("/v1/messages") ||
    sourceFormat === "claude" ||
    sourceFormat === "claude-messages"
  ) {
    clientFormat = "claude";
  } else if (
    endpoint.includes("/v1/chat/completions") ||
    sourceFormat === "openai" ||
    sourceFormat === "openai-chat"
  ) {
    clientFormat = "openai";
  }

  if (!clientFormat) {
    return { handled: false };
  }

  const messages =
    (body.messages as Array<{ role: string; content: unknown; tool_calls?: unknown }>) || [];
  const tools = body.tools;
  const tool_choice = body.tool_choice;
  const system = body.system;

  const analysis = analyzeAttachmentPreflight({
    messages,
    tools,
    tool_choice,
    system,
    format: clientFormat,
  });

  if (analysis.status === "NO_ATTACHMENTS") {
    return { handled: false };
  }

  if (analysis.status === "TOO_MANY_FILES" || analysis.status === "FAILED") {
    const errorMsg = analysis.error;
    const errRes =
      clientFormat === "claude"
        ? buildClaudeErrorResponse(errorMsg, model, stream)
        : buildOpenAiErrorResponse(errorMsg, model, stream);
    return { handled: true, response: errRes };
  }

  if (analysis.status === "REQUEST_NEEDED") {
    const toolUseRes =
      clientFormat === "claude"
        ? buildClaudeStreamingToolUseResponse(analysis.toolCalls, model)
        : buildOpenAiToolUseResponse(analysis.toolCalls, model, stream);

    const res =
      clientFormat === "claude"
        ? stream
          ? toolUseRes
          : buildClaudeNonStreamingToolUseResponse(analysis.toolCalls, model)
        : toolUseRes;

    return { handled: true, response: res };
  }

  if (analysis.status === "COMPLETE") {
    // Attach resolved documents to body for downstream purifier & executor consumption
    (body as Record<string, unknown>)._deepThinkPreflightDocs = analysis.resolvedFiles;
    (body as Record<string, unknown>)._deepThinkUserQuestion = analysis.genuineUserText;
    (body as Record<string, unknown>)._deepThinkUserTurnIndex = analysis.genuineUserTurnIndex;

    return {
      handled: false,
      readyDocuments: analysis.resolvedFiles,
      genuineUserTurnIndex: analysis.genuineUserTurnIndex,
      genuineUserText: analysis.genuineUserText,
    };
  }

  return { handled: false };
}
