/** The numeric part of a GPT model id, with an optional minor version. */
export function gptModelVersion(model: string): string | undefined {
  return model.match(/^gpt-(\d+(?:\.\d+)?)/)?.[1]
}
