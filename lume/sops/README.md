# Cold-email SOPs

The `.md` files here are the source of truth. The agent's system prompt, the
`update_sequence` lint gate and the PDF are all built from them; nothing is
copied anywhere else.

- `cold-email-sop.md`: the **base** SOP (general rules, generic fallbacks).
- `clients/<client>.md`: a **client overlay** (e.g. `clients/kaspen.md`), with
  the same YAML header shape plus `client`, `name` and `match`, then that
  client's own prose.

Each file starts with a YAML front-matter block (`---` … `---`) holding the
machine rules, followed by prose.

## How the rules are used

- **Lint gate.** `lib/copy/sopLint.ts` checks every `update_sequence` edit
  (from the editor or the agent) against the base plus the overlay matching the
  target campaign. It runs when the approval is built, when it is created, and
  again in the executor before anything is written to Instantly. A blocking
  violation refuses the edit and names the rule, step and variant. The
  sequence-shape rule (`sequence`) is a warning only.
- **Placeholder base.** While the base has `placeholder: true`, its rules
  only warn. A campaign that no client SOP covers is never refused; it gets
  warnings in the tool log, the editor and `/actions/<id>`. A client
  campaign is refused only by the rules its overlay sets. Once the base is
  `placeholder: false`, its rules block too.
- **Overlay selection.** An overlay applies to a campaign when the campaign's
  name contains one of `match.campaign_names` (case-insensitive) or its id is
  in `match.campaign_ids`. If two overlays match one campaign, that is an
  error. In an agent chat, the overlay is chosen by the chat's vertical
  (`match.vertical`) or by a vertical or project name containing the client
  id, its name or a campaign name. Otherwise the agent sees the list of
  overlays and loads one with `get_sop`.
- **Merge.** `banned_phrases` from the overlay are added to the base list.
  The object sections (`word_count`, `subject`, `step1_cta`, `fallbacks`,
  `only_in_step`, `step_rules`, `signoff`) merge key by key, and the overlay's
  value wins. Any other key the overlay sets replaces the base's value.
- **Variables.** `{{company}}` and `{{companyName}}` count as the same
  personalization field.
- **Fails loudly.** `lib/copy/sop.ts` validates every file with zod. A typo'd
  key, a wrong type, `min` greater than `max`, a bad regex, or an overlay that
  breaks the merged rules fails `npx vitest run`, `next build`, `next dev` and
  `next start` (through `next.config.ts`). At runtime it also refuses every
  sequence edit and agent run. Linting is never skipped.
- **Bundling.** The files are read from disk at runtime.
  `outputFileTracingIncludes` in `next.config.ts` ships `sops/**/*.md` with
  every server function.

## PDF

`cold-email-sop.Rmd` knits the base SOP plus one client overlay into a PDF.
It reads the `.md` files directly: the YAML becomes tables and the prose is
printed as written.

```r
# from lume/sops/
rmarkdown::render("cold-email-sop.Rmd")                                # base + kaspen (the default)
rmarkdown::render("cold-email-sop.Rmd", params = list(client = "acme")) # base + clients/acme.md
rmarkdown::render("cold-email-sop.Rmd", params = list(client = ""))     # base only
```

Requirements:

- R packages `rmarkdown`, `knitr` and `yaml`.
- pandoc. RStudio bundles one; from a terminal, set `RSTUDIO_PANDOC` to its
  directory, e.g.
  `/Applications/RStudio.app/Contents/Resources/app/quarto/bin/tools/aarch64`.
- A LaTeX install with `xelatex`, e.g. `tinytex::install_tinytex()`.

Don't commit the generated PDF.
