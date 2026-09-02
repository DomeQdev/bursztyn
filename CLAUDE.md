# CLAUDE.md

See @AGENTS.md — it covers both using bursztyn in a project (schema changes, the migration workflow,
every error and its fix) and working on this library's source.

Two things worth having in front of you before you touch a schema:

- Files under the migrations folder (`amber/` by default) are generated. The only edits you make
  there are the body of `up()`, removing names from `pending`, and adding to `rebuilds`.
- Never delete the migrations folder to clear an error. It is the only record of how existing
  snapshots reach the current schema.
