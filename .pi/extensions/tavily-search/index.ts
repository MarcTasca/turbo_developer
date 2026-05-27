import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  raw_content?: string | null;
};

type TavilyResponse = {
  answer?: string;
  query?: string;
  response_time?: number;
  results?: TavilyResult[];
};

function requireApiKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    throw new Error(
      "Missing TAVILY_API_KEY. Add it to your shell profile or Pi launch environment. Do not commit it to the repo.",
    );
  }
  return key;
}

function formatResponse(data: TavilyResponse): string {
  const lines: string[] = [];
  if (data.answer) {
    lines.push(`# Tavily answer\n${data.answer.trim()}\n`);
  }

  const results = data.results ?? [];
  if (results.length > 0) {
    lines.push("# Sources");
    results.forEach((result, index) => {
      lines.push(
        [
          `## ${index + 1}. ${result.title ?? "Untitled"}`,
          result.url ? `URL: ${result.url}` : undefined,
          typeof result.score === "number" ? `Score: ${result.score}` : undefined,
          result.content ? `Summary: ${result.content.trim()}` : undefined,
          result.raw_content ? `Raw content excerpt: ${result.raw_content.trim().slice(0, 4000)}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });
  }

  return lines.join("\n\n").trim() || "No Tavily results returned.";
}

export default function tavilySearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with Tavily for current documentation, best practices, APIs, and factual research.",
    promptSnippet: "Search the web with Tavily and return cited sources.",
    promptGuidelines: [
      "Use web_search when the user asks for online research, current best practices, documentation, comparisons, or facts that may have changed after training.",
      "When using web_search, cite source URLs in the final answer and distinguish researched facts from local repo findings.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      searchDepth: Type.Optional(
        Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
          description: "Use advanced for deeper research. Defaults to advanced.",
        }),
      ),
      maxResults: Type.Optional(
        Type.Number({ minimum: 1, maximum: 10, description: "Maximum number of results. Defaults to 5." }),
      ),
      includeAnswer: Type.Optional(Type.Boolean({ description: "Ask Tavily for a synthesized answer. Defaults to true." })),
      includeRawContent: Type.Optional(
        Type.Boolean({ description: "Include raw page excerpts when available. Defaults to false." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const apiKey = requireApiKey();
      const maxResults = Math.max(1, Math.min(10, Math.round(params.maxResults ?? 5)));

      onUpdate?.({ content: [{ type: "text", text: `Searching Tavily: ${params.query}` }] });

      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: params.query,
          search_depth: params.searchDepth ?? "advanced",
          max_results: maxResults,
          include_answer: params.includeAnswer ?? true,
          include_raw_content: params.includeRawContent ?? false,
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Tavily request failed (${response.status}): ${body.slice(0, 1000)}`);
      }

      const data = (await response.json()) as TavilyResponse;
      return {
        content: [{ type: "text", text: formatResponse(data) }],
        details: data,
      };
    },
  });

  pi.registerCommand("web-search", {
    description: "Ask the agent to search the web with Tavily. Usage: /web-search <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /web-search <query>", "warning");
        return;
      }
      if (!process.env.TAVILY_API_KEY) {
        ctx.ui.notify("Missing TAVILY_API_KEY in the Pi environment", "error");
        return;
      }
      pi.sendUserMessage(`Search the web using web_search and answer with citations: ${query}`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!process.env.TAVILY_API_KEY) {
      ctx.ui.notify("Tavily web_search loaded, but TAVILY_API_KEY is not set", "warning");
    }
  });
}
