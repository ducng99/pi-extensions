---
description: git stage & commit files
---

stage files & commit changes

use conventional commit prefixes:
- feat: - new feature
- fix: - bug fix
- docs: - documentation only
- style: - formatting, missing semicolons, etc
- refactor: - code change that neither fixes a bug nor adds a feature
- perf: - performance improvement
- test: - adding or correcting tests
- chore: - maintenance tasks
- revert: - reverting a previous commit

prefer to explain WHY something was done from an end user perspective instead of WHAT was done.

for big changes, do not do generic messages like "improved agent experience" be very specific about what user facing changes were made.
if the change is small, less than 50 diff lines, keep the message single-line only

if there are conflicts DO NOT FIX THEM. notify me and I will fix them

## GIT DIFF

!`git diff`

## GIT DIFF --cached

!`git diff --cached`

## GIT STATUS --short

!`git status --short`
