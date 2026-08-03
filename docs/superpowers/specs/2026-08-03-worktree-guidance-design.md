# Worktree Guidance Design

## Goal

Document the repository convention that all task-specific Git worktrees are
created inside `.worktrees/` at the repository root, while ensuring that the
directory remains ignored by Git.

## Scope

- Update the existing `AGENTS.md`; do not create a duplicate lowercase file.
- Add one explicit worktree-location rule near the agent workflow guidance.
- Remove the duplicate `.worktrees/` entry from `.gitignore`, leaving one
  canonical ignore rule.
- Do not add hooks, scripts, or other enforcement mechanisms.

## Validation

Confirm the documentation and ignore rule are present, `git check-ignore`
recognizes `.worktrees/`, and the resulting commit can be merged into local
`main` without changing unrelated files.
