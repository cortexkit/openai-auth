# OpenAI sidebar buffers

These character frames and serialized span buffers were frozen from openai-auth's
renderer at `5da845f9cf86416c9fb7bc52936fda5941a8a35e`, before replacing its
presentation with `@cortexkit/common-auth/quota-sidebar`. Both the OpenCode 1 and
OpenCode 2 entry points produced each buffer. No whitespace, colors, attributes,
or narrow-width overflow was normalized.

The buffers follow common-auth 0.32's presentation (verified against 0.32.1): the
shell loses its top row and side padding, and unnamed windows no longer reserve
a name gutter. Collapsed rows keep their quota suffix whole (or omit it) and
always end with a status
glyph, even without a reading. Expanded names ellipsize before the status, and
bars shrink before reset times are dropped. These shared presentation rules
deliberately revise the historical buffers rather than preserve their overflow.

`sidebar-golden-render.ts` fixes time, theme and a local account roster: an active
account with pacing, credit budget, prepaid and reset credits; a blocked idle
account with a stale reading; and an unloaded spare. Expanded frames include the
plugin's Routing, Health and Killswitch sections. Widths 16, 36, 37 and 42 cover
narrow and default host layouts, in both expanded and collapsed modes.
`expanded-initial-30.json` also preserves the first narrow layout before resizing; it
was captured separately by restoring the same pre-refactor renderer.

After building, run `bun test src/tests/tui-sidebar-golden.test.ts` from
`packages/opencode`. Changing the expected buffers is a visual contract change,
not a routine snapshot update. The fixture's `FREEZE_SIDEBAR_GOLDENS=1` switch is
only for an explicitly reviewed visual change: it captures the currently built
plugin, not the historical baseline automatically.
