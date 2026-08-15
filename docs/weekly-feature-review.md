# Weekly feature-review issue hygiene

This repository uses weekly tracking issues titled:

- `Weekly feature review YYYY-MM-DD`

Those issues are labelled `bot-proposed` + `meta` and are meant to stay open
only until the summary comment and child issue fan-out are complete.

## Script

Use:

```bash
npm run weekly-review:hygiene
```

Default mode is **dry-run** and prints candidates it would close.

To apply closure actions:

```bash
npm run weekly-review:hygiene -- --apply
```

To target a specific issue:

```bash
npm run weekly-review:hygiene -- --issue 111
```

## Close criteria

An issue is eligible when all of the following are true:

1. Title matches `Weekly feature review YYYY-MM-DD`
2. Body matches the weekly tracking template text
3. Issue is still open
4. At least one comment contains `Weekly feature-review summary`

When run with `--apply`, the script:

1. Posts a close-out comment
2. Closes the issue with reason `completed`

This prevents stale weekly tracker issues from lingering after their follow-up
issues have already been filed.