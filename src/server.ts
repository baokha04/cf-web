import { Agent, callable, routeAgentRequest } from "agents";
import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createWorkersAI } from "workers-ai-provider";

/**
 * Instrument the AI SDK once, at module scope, and use these wrapped functions
 * everywhere instead of importing them from "ai" directly.
 *
 * wrapAISDK instruments generateText, streamText, generateObject and
 * streamObject, projecting the OpenTelemetry GenAI semantic conventions onto
 * Workers' native custom spans. It supports AI SDK v6 and v7, and is a no-op
 * when the runtime has no native tracing capability.
 *
 * Payload storage is OFF by default. The two flags below opt in to recording
 * message and tool payloads on spans:
 *   storeMessages -> gen_ai.input.messages / gen_ai.output.messages on `chat`
 *   storeTools    -> gen_ai.tool.call.arguments / .result on `execute_tool`
 * Both write real prompt and tool data into your traces. Turn them off if this
 * agent handles anything you would not want stored in Workers Observability.
 */
const { generateText, streamText } = wrapAISDK(ai, {
  storeMessages: true,
  storeTools: true,
  // Emitted as cloudflare.agents.runtime_context.{key}. Scalars only —
  // objects and arrays are dropped.
  includeRuntimeContext: ["requestId", "tenantId"]
});

type State = {
  count: number;
};

export class TracedAgent extends Agent<Env, State> {
  initialState: State = { count: 0 };

  /**
   * Agents are traced out of the box once observability.traces.enabled is set
   * in wrangler.jsonc. On every inference the SDK supplies durable identity:
   *   gen_ai.agent.name      = "TracedAgent"  (this.constructor.name)
   *   gen_ai.agent.id        = this.name      (the DO instance name)
   *   gen_ai.conversation.id = this.ctx.id    (the opaque DO ID)
   * No per-call telemetry options are needed. A turn produces an
   * `invoke_agent TracedAgent` span with `chat {model}` and
   * `execute_tool {tool}` spans beneath it.
   */
  @callable()
  async ask(prompt: string) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const { text } = await generateText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct"),
      prompt
    });
    return text;
  }

  @callable()
  async askStreaming(prompt: string) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct"),
      prompt
    });
    return result.toTextStreamResponse();
  }

  @callable()
  increment() {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }

  /**
   * Plain HTTP entry point, so the agent is reachable without a WebSocket
   * client. Every request through here runs inside the agent's traced context.
   *
   *   GET  /agents/traced-agent/{instance}          -> current state
   *   POST /agents/traced-agent/{instance}/increment -> bump the counter
   *   POST /agents/traced-agent/{instance}/ask       -> { "prompt": "..." }
   */
  async onRequest(request: Request) {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname.endsWith("/increment")) {
      return Response.json({ count: this.increment() });
    }

    if (request.method === "POST" && pathname.endsWith("/ask")) {
      const { prompt } = (await request.json()) as { prompt?: string };
      if (!prompt) {
        return Response.json({ error: "missing prompt" }, { status: 400 });
      }
      return Response.json({ text: await this.ask(prompt) });
    }

    return Response.json({ agent: this.name, state: this.state });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
