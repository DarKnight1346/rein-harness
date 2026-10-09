# Expand / contract: a breaking change in safe steps

Plan mode is on: change nothing until the user approves the plan. The change the user named would break something if done in one step: running code, other services, mobile apps that update late, or data already stored. Plan it as **expand → migrate → contract**, where every step can be deployed (and rolled back) on its own and the system works between any two steps.

## 1. Pin down the change

- What changes: a column, table, API field, endpoint, message field, event, config key? From what to what?
- **Who depends on the old shape.** Search this repo and, in a workspace, every repo (search and list with `workspace: true`); with `org_search` available, the whole org. List readers and writers separately: code that writes the old shape, code that reads it, stored data, and clients you can't redeploy (mobile apps, partners, other teams).
- How it's deployed: one service or several, deploy order, whether old and new versions run side by side during a deploy (assume yes).
- Run `/contracts` (or read the contract files) to see what the change breaks today.

Ask with `ask_user` what you can't find: deploy order, how long old clients live, data volume, whether a short write freeze is acceptable.

## 2. Pick the pattern

| Change | Expand | Migrate | Contract |
| --- | --- | --- | --- |
| **Rename a column or field** | Add the new one; write both (dual-write), read the old | Backfill new from old in batches; switch reads to new; verify they match | Stop writing old; drop it (in a later deploy) |
| **Change a type** (int → string, cents → decimal) | Add a new column/field with the new type; dual-write with conversion | Backfill; switch reads; compare | Drop the old one |
| **Make something required** | Add it as optional, with a default where writers don't send it | Backfill missing values; make every writer send it | Add the NOT NULL / required constraint (validated after) |
| **Split a table or service** | Create the new one; dual-write | Backfill; move reads one caller at a time | Stop writes to the old; remove it |
| **Remove an API field or endpoint** | Mark it deprecated (OpenAPI `deprecated: true`, GraphQL `@deprecated`, protobuf `[deprecated = true]`); log or count its use | Move every client off it; wait out clients you can't redeploy | Remove it; for protobuf, `reserved` its number and name |
| **Rename an API field** | Add the new field, return both, accept both | Move clients to the new name | Stop returning and accepting the old one |
| **Change an event or message schema** | Add fields with defaults (Avro) or new numbers (protobuf); consumers accept both | Producers switch to the new fields | Remove the old fields once every consumer reads the new ones |

## 3. Write the plan

For each step, as its own section:

- **What changes** (files, the migration or contract edit) and **why it's safe to deploy alone**: which old and new versions still work against it.
- **Data work**: backfills in batches (size, throttling, resumable, idempotent), not in the migration that changes the schema. Migrations that lock: use the safe forms (`CREATE INDEX CONCURRENTLY`, `ADD CONSTRAINT … NOT VALID` then `VALIDATE`, no table rewrites on large tables).
- **How to verify** before moving on: dual-read comparisons, counts of rows still on the old shape, metrics or logs showing nobody uses the old field.
- **Rollback**: how to undo this step alone.

Make each step a milestone ("new column written by every writer, backfill at 0 remaining rows", "no reads of `old_name` for 7 days"). Steps that need waiting (old clients to update, a backfill to finish) say so; they are separate deploys, not one PR.

Then call `present_plan`.
