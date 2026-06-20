# `getWeather` returning a list of objects breaks LangChain.js tools

A `get_weather` tool that returns a multi-day forecast as a **list of objects** —
the "structured results the model should parse" that the
[LangChain tool docs](https://docs.langchain.com/oss/javascript/langchain/tools)
explicitly tell you to return — produces a broken request in `@langchain/core`:

- **OpenAI** rejects it: `400 Missing required parameter: 'messages[N].content[0].type'`
- **Anthropic** returns no error, but the tool result is **silently dropped** —
  the model receives an empty `tool_result` and answers without the data.

```ts
const getWeather = tool(
  ({ city }) => [
    { day: "Mon", highF: 64, lowF: 53, condition: "Foggy" },
    { day: "Tue", highF: 67, lowF: 54, condition: "Partly cloudy" },
    { day: "Wed", highF: 70, lowF: 55, condition: "Sunny" },
  ],
  { name: "get_weather", description: "...", schema: z.object({ city: z.string() }) },
);
```

## Run

```bash
npm install
cp .env.example .env     # add OPENAI_API_KEY and ANTHROPIC_API_KEY
npm start
```

`index.ts` runs a real agent turn against each provider: the model calls
`get_weather`, the tool returns the forecast list, and the follow-up turn carries
the result — which is where it breaks. No agent framework or extra config.

## Actual output

```
========== OPENAI ==========
get_weather returned -> ToolMessage.content is a JS array (forwarded as content blocks):
    [{"day":"Mon","highF":64,...},{"day":"Tue",...},{"day":"Wed",...}]
tool result as received by the provider: [{"day":"Mon",...},...]
RESULT: ❌ 400 Missing required parameter: 'messages[2].content[0].type'.

========== ANTHROPIC ==========
get_weather returned -> ToolMessage.content is a JS array (forwarded as content blocks):
    [{"day":"Mon","highF":64,...},...]
tool result as received by the provider: []
RESULT: ✅ no error. Final answer: I apologize, but it seems the weather forecast
        data for San Francisco isn't currently available. The tool ran but didn't
        return any forecast information...
   ⚠️  but the forecast was DROPPED (empty tool_result) — the answer is not grounded in the tool output.
```

## Root cause

`@langchain/core` → `dist/tools/index.js`, `_formatToolOutput`:

```js
if (typeof content === "string" ||
    (Array.isArray(content) && content.every((item) => typeof item === "object")))
    return new ToolMessage({ content, ... });        // forwarded VERBATIM as content blocks
else
    return new ToolMessage({ content: _stringify(content), ... });  // stringified
```

Any array whose every element is an object is assumed to already be a list of
message content blocks (`MessageContentComplex[]`) and forwarded unchanged. The
forecast objects have no `type` field, so the provider request is malformed.
Returning a single object, an array of strings/numbers, or a scalar all get
stringified and work — the bug is specific to a **list of objects**.

## Fix

Require the elements to actually look like content blocks before treating the
array as such (matching the Python implementation, which checks each dict for a
recognized `type`):

```js
const looksLikeContentBlocks = Array.isArray(content) && content.length > 0 &&
  content.every((item) => item != null && typeof item === "object" && typeof item.type === "string");

if (typeof content === "string" || looksLikeContentBlocks)
    return new ToolMessage({ content, ... });
else
    return new ToolMessage({ content: _stringify(content), ... });
```

Reproduced on `@langchain/core` 1.2.0, `@langchain/openai` 1.5.0,
`@langchain/anthropic` 1.5.0. The Python `langchain-core` equivalent is **not**
affected (it stringifies the list).
