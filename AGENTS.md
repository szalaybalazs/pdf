## Imported Claude Cowork project instructions

## Project-local skill: release

Use this workflow only for this repository when the user asks for `release` or
asks to cut a release.

1. Inspect the worktree first with `git status --short`. Do not include unrelated
   user changes in the release commit. If unrelated changes are present, work
   around them by staging only the release files.
2. Identify the previous release with the latest reachable `v*` tag, then review
   the commits and relevant diff from that tag through `HEAD` (for example,
   `git log --oneline <tag>..HEAD`). Draft user-facing release notes in
   `app/release-notes.md` from those commits. Use the user's prompt as guidance
   when they provide release-note text or highlights, but still check the
   commits since the last version tag so important changes are not missed. Keep
   the notes concise, plain text/Markdown, and suitable for display in the app
   updater. Do not include HTML comments, internal commit noise, or
   implementation-only details.
3. Show the drafted release notes to the user and ask for approval before
   changing the version. Do not bump the version, commit, or tag until the user
   approves the notes.
4. After approval, bump the app version from `app/` using `npm version <level>`,
   where `<level>` is the version bump requested by the user (`patch`, `minor`,
   `major`, or an explicit SemVer version). If the prompt does not specify a
   bump, use `patch`. Let `npm version` create the version commit and `v*` tag.
5. Verify the result with `git status --short`, `git log -1 --oneline`, and
   `git tag --points-at HEAD`. Report the new version, commit, tag, and any
   files left uncommitted.
6. Never push as part of this skill. Do not run `git push`, `npm publish`, or
   `npm run publish` unless the user separately asks for that later.
