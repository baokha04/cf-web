/**
 * Tail Worker — production sink for the Agents SDK's structured events.
 *
 * The agents SDK publishes events to node:diagnostics_channel and they are
 * silent by default (zero overhead when nobody is listening). In production
 * all diagnostics channel messages are forwarded here automatically — no
 * subscribe() call is needed inside the agent itself.
 *
 * Channels you will see on msg.channel:
 *   agents:rpc         agents:state        agents:schedule
 *   agents:lifecycle   agents:workflow     agents:mcp
 *   agents:email       agents:agent_tool
 *
 * Note the raw channel names are snake_case (`agents:agent_tool`); only the
 * typed subscribe() helper uses camelCase keys (`subscribe("agentTool", ...)`).
 *
 * Deploy separately:  npm run deploy:tail
 * It is wired to the main Worker via "tail_consumers" in wrangler.jsonc.
 */

type DiagnosticsChannelEvent = {
  channel: string;
  message: unknown;
  timestamp: number;
};

export default {
  async tail(events: TraceItem[]) {
    for (const event of events) {
      const channelEvents =
        (event as unknown as { diagnosticsChannelEvents?: DiagnosticsChannelEvent[] })
          .diagnosticsChannelEvents ?? [];

      for (const msg of channelEvents) {
        // Structured and filterable: ship this wherever you keep logs.
        console.log(
          JSON.stringify({
            timestamp: msg.timestamp,
            channel: msg.channel,
            event: msg.message
          })
        );
      }
    }
  }
} satisfies ExportedHandler;
