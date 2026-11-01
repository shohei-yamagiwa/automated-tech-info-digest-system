import type Anthropic from "@anthropic-ai/sdk";
import type { StructuredCall } from "./judge.js";

const TOOL_NAME = "record_result";
const MAX_OUTPUT_TOKENS = 32000;

export function anthropicStructuredCall(
  client: Anthropic,
  model: string,
): StructuredCall {
  return async ({ system, user, schema }) => {
    const message = await client.messages
      .stream({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        tools: [
          {
            name: TOOL_NAME,
            description: "判定結果を記録する",
            input_schema: schema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
      })
      .finalMessage();

    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse) throw new Error("Claude did not return a tool_use block");
    return toolUse.input;
  };
}
