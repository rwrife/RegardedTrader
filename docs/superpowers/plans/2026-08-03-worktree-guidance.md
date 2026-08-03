# Worktree Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document that repository worktrees belong under `.worktrees/` and keep that directory ignored by Git.

**Architecture:** This is a documentation-only change. The existing `AGENTS.md` is the single source of agent workflow guidance, and the root `.gitignore` provides the single ignore rule for local worktrees.

**Tech Stack:** Markdown, Git.

---

### Task 1: Document the worktree location

**Files:**
- Modify: `AGENTS.md` near the “When You're An Agent Working Here” section.

- [ ] **Step 1: Add the repository worktree rule**

Add this guidance before the existing “Read this file first” bullet:

```md
- Create all task-specific Git worktrees under `.worktrees/<name>` at the
  repository root. Keep the primary checkout on `main` or the relevant base
  branch, and do not create task worktrees beside or above the repository.
```

- [ ] **Step 2: Review the wording**

Run:

```powershell
Select-String -Path AGENTS.md -Pattern '\.worktrees/<name>'
```

Expected: one matching rule that requires worktrees under the repository-root
`.worktrees/` directory.

- [ ] **Step 3: Commit the guidance**

```powershell
git add AGENTS.md
git commit -m "docs: require repository-local worktrees"
```

### Task 2: Normalize the ignore rule

**Files:**
- Modify: `.gitignore` at the existing “local git worktrees” entries.

- [ ] **Step 1: Remove the duplicate entry**

Keep exactly one rule:

```gitignore
# local git worktrees
.worktrees/
```

- [ ] **Step 2: Verify Git ignores the directory**

Run:

```powershell
git check-ignore -v .worktrees/worktree-guidance
```

Expected: the command reports `.gitignore` as the source of the `.worktrees/`
ignore rule.

- [ ] **Step 3: Commit the normalized ignore file**

```powershell
git add .gitignore
git commit -m "chore: normalize worktree ignore rule"
```

### Task 3: Validate and merge

**Files:**
- Review: `AGENTS.md`
- Review: `.gitignore`

- [ ] **Step 1: Confirm only intended files changed**

Run:

```powershell
git status --short
git diff main...HEAD --stat
```

Expected: only `AGENTS.md`, `.gitignore`, and the approved design/plan
documentation are changed.

- [ ] **Step 2: Confirm the worktree is registered in the required location**

Run from the repository root:

```powershell
git worktree list
```

Expected: the active task worktree path is
`<repo>/.worktrees/worktree-guidance`.

- [ ] **Step 3: Fast-forward or merge the branch into local `main`**

From the primary checkout:

```powershell
git switch main
git merge --ff-only chore/worktree-guidance
```

Expected: local `main` contains the documentation, ignore cleanup, design
specification, and implementation plan commits without a merge conflict.
