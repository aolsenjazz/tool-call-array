import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { AIMessage, ToolMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";

const getWeather = tool(
  () => [
    { day: "Mon", highF: 64, lowF: 53, condition: "Foggy" },
    { day: "Tue", highF: 67, lowF: 54, condition: "Partly cloudy" },
    { day: "Wed", highF: 70, lowF: 55, condition: "Sunny" },
  ],
  {
    name: "get_weather",
    description: "Get the multi-day weather forecast for a city.",
    schema: z.object({ city: z.string().describe("The city to get the forecast for.") }),
  },
);

// Wrap the provider's fetch to print the tool result exactly as it leaves for
// the API — i.e. what the model actually receives, after LangChain serializes it.
function showToolResult(provider: "openai" | "anthropic") {
  return (async (url: any, init: any) => {
    try {
      const { messages } = JSON.parse(init.body);
      const sent =
        provider === "openai"
          ? messages.find((m: any) => m.role === "tool")?.content
          : messages
              .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
              .find((b: any) => b?.type === "tool_result")?.content;
      if (sent !== undefined) console.log(`   tool result the model receives: ${JSON.stringify(sent)}`);
    } catch {}
    return fetch(url, init);
  }) as any;
}

async function demo(provider: "openai" | "anthropic"): Promise<void> {
  console.log(`\n=== ${provider} ===`);
  const fetch = showToolResult(provider);
  const model =
    provider === "openai"
      ? new ChatOpenAI({ model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini", maxRetries: 0, configuration: { fetch } })
      : new ChatAnthropic({ model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5", maxRetries: 0, clientOptions: { fetch } });

  const bound = model.bindTools([getWeather]);
  const messages: BaseMessage[] = [new HumanMessage("What's the weather forecast in San Francisco this week?")];

  try {
    // Turn 1: the model decides to call get_weather.
    const ai = (await bound.invoke(messages)) as AIMessage;
    if (!ai.tool_calls?.length) {
      console.log("model did not call the tool on this run; re-run or rephrase.");
      return;
    }
    messages.push(ai);

    // Execute the tool to get the ToolMessage @langchain/core builds.
    for (const tc of ai.tool_calls) {
      const tm = (await getWeather.invoke(tc)) as ToolMessage;
      messages.push(tm);
    }

    // Turn 2: send the tool result back. This is where it breaks.
    const final = (await bound.invoke(messages)) as AIMessage;
    const text = typeof final.content === "string" ? final.content : JSON.stringify(final.content);
    // If the forecast survived, the answer mentions it. If not, the request
    // "succeeded" but the tool output was silently dropped before the model saw it.
    const grounded = ["Foggy", "Sunny", "64", "70"].some((fact) => text.includes(fact));
    if (grounded) console.log(`RESULT: ✅ grounded in tool data: ${text.slice(0, 160)}`);
    else console.log(`RESULT: ⚠️  SILENT FAILURE — no error, but the tool output was dropped (answer is not grounded): ${text.slice(0, 160)}`);
  } catch (e: any) {
    console.log(`RESULT: ❌ ${e?.status ?? ""} ${(e?.message ?? String(e)).split("\n")[0]}`);
  }
}

// Run both providers; each is self-contained so one failing never skips the other.
await demo("openai");
await demo("anthropic");
process.exit(0);
