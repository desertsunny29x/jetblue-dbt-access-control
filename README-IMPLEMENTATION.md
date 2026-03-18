# Automated develop -> master release PR

This package creates or updates one automated pull request per day from `develop` to `master` after any PR is merged into `develop`.

## What it does

- Triggers when a pull request to `develop` is merged.
- Creates or updates `automation/release-YYYY-MM-DD`.
- Regenerates `CHANGELOG.md` grouped by merge date.
- Regenerates a marked `README.md` section with badges, release number, and PR details.
- Opens or updates a release PR targeting `master`.
- Applies labels like `auto-release`.
- Can optionally enable GitHub auto-merge if your protected-branch settings allow it.

## Required repository settings

1. Keep `master` protected.
2. Allow pull requests into `master`.
3. Add the `Validate automated release PR` workflow as a required status check.
4. If you want full automation, allow a trusted actor (GitHub App or permitted bot) to bypass or satisfy your protection rules, then set `AUTO_MERGE` to `true`.

## Files

- `.github/workflows/release-pr.yml`
- `.github/workflows/release-pr-checks.yml`
- `.github/scripts/sync-develop-to-master.mjs`

## Notes

- The workflow never pushes directly to `master`; it respects branch protection and works through PRs.
- The changelog is grouped by date, which fits multiple merged PRs per day.
- The README section uses markers so your manual content remains untouched.
