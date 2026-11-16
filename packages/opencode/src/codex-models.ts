export const ALLOWED_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
])
// The suffix-less gpt-5.6 model is rejected by the Codex OAuth backend
// ("not supported when using Codex with a ChatGPT account"); only the
// -luna/-sol/-terra variants work. Its -fast/-pro synthetics inherit the same
// api.id ("gpt-5.6"), so filtering on api.id drops them all at once while
// keeping the working variants (api.id gpt-5.6-luna, etc.).
// Same shape for gpt-6: the backend rejects the bare id ("not supported when
// using Codex with a ChatGPT account") and serves only the named variants
// (gpt-6-astra, gpt-6-sol, gpt-6-luna), so any -fast/-pro synthetics inheriting
// api.id "gpt-6" drop with it. gpt-6.1 is the same again: gpt-6.1-sol and
// gpt-6.1-terra are served, but the bare id (like gpt-6.1-luna and
// gpt-6.1-astra) answers 400.
export const DISALLOWED_MODELS = new Set(['gpt-5.6', 'gpt-6', 'gpt-6.1'])

/**
 * Whether a model (by its API id) is offered on a ChatGPT login: the allow
 * list, else not the deny list and a GPT version above 5.4. The caller drops
 * `pro` reasoning variants itself. Shared by the OpenCode 1 models hook and
 * the OpenCode 2 model transform.
 */
export function codexOAuthModelListed(apiId: string): boolean {
  if (ALLOWED_MODELS.has(apiId)) return true
  if (DISALLOWED_MODELS.has(apiId)) return false
  // The minor is optional: a major-only id like gpt-6-astra carries no
  // decimal, and requiring one silently dropped it from the catalogue even
  // though the backend serves it.
  const match = apiId.match(/^gpt-(\d+(?:\.\d+)?)/)
  const version = match?.[1]
  return version ? parseFloat(version) > 5.4 : false
}

/**
 * The context window a ChatGPT login gets for a model (by its id), or
 * undefined to keep the model's own. Shared by the OpenCode 1 models hook and
 * the OpenCode 2 model transform.
 */
export function codexOAuthModelLimit(
  modelId: string,
): { context: number; input: number; output: number } | undefined {
  if (modelId.includes('gpt-5.5'))
    return { context: 400_000, input: 272_000, output: 128_000 }
  // OpenAI's ChatGPT rate card (help.openai.com/en/articles/20001415, read
  // 2026-10-26), "Long-context pricing in Codex": "When you use Codex signed
  // in with ChatGPT, no long-context multiplier applies to any Codex model,
  // including requests above 272K input tokens."
  //
  // The 5.6 variants, gpt-6-sol and gpt-6-luna had 372k context / 244k input
  // caps only to avoid the former 2x long-context charge. With that charge gone,
  // they use the Codex catalog's reported max_context_window of 872000, as
  // gpt-6-astra already does. Input and output share the window, so `input`
  // leaves a 128k output reserve.
  //
  // This pricing applies to the default ChatGPT endpoint. A `codexApiEndpoint`
  // override pointed at a relay or differently billed surface may still charge;
  // the operator must re-check its pricing rather than assume the exemption.
  if (
    modelId.includes('gpt-5.6') ||
    modelId.includes('gpt-6-astra') ||
    modelId.includes('gpt-6-sol') ||
    modelId.includes('gpt-6-luna')
  )
    return { context: 872_000, input: 744_000, output: 128_000 }
  // gpt-6.1-sol gets Codex's own 500k default context (raised from 272k
  // around 2026-10-12). gpt-6.1-terra uses the same default: Codex CLI's
  // models_cache.json (client 0.164.0, fetched 2026-10-26T18:37Z) reports
  // context_window 500000, despite max_context_window 872000. `input` is the
  // default window minus the 128k output reserve. As for gpt-6-astra, an
  // endpoint override pointed at a differently billed surface is the operator's
  // to re-check; the ChatGPT rate card does not establish platform API pricing.
  if (modelId.includes('gpt-6.1-sol') || modelId.includes('gpt-6.1-terra'))
    return { context: 500_000, input: 372_000, output: 128_000 }
  return undefined
}

/** Terra supports Sol's reasoning variants before every host catalog knows it. */
export function codexOAuthModelVariantSource(
  modelId: string,
): string | undefined {
  return modelId === 'gpt-6.1-terra' ? 'gpt-6.1-sol' : undefined
}
