# Prompt Budgeting

Each request is assembled from a system prompt, retrieved context, and history.

## Budget

| Section | Budget |
|---|---|
| system prompt | 2 000 tokens |
| retrieved context | 6 000 tokens |
| history | 4 000 tokens |
| reserve for output | 2 000 tokens |

The total is capped at the model's context window minus the output reserve.

## Truncation

When over budget, history is truncated oldest-first, then retrieved context,
then the system prompt. Truncating the system prompt is a last resort and logs
a warning.

## Ordering

Retrieved context is ordered by score, so truncation removes the lowest-scoring
documents. Ties are broken by insertion order, which is not stable across runs,
so two identical requests can produce different prompts.

## Known gap

Token counts are estimated with a character/4 heuristic. For non-English text
this underestimates by up to 40 percent, so a request that appears to fit can
exceed the window and be rejected by the provider.
