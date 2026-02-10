type TextContent = {
  type: "text";
  text: string;
};

type ToolResult = {
  content: TextContent[];
  isError?: boolean;
};

export function successResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: pretty(value),
      },
    ],
  };
}

export function errorResult(error: unknown): ToolResult {
  const message =
    error instanceof Error ? error.message : "Unknown error while executing tool.";

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
