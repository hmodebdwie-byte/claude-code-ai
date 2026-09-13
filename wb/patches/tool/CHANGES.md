# TickTrade Intelligence Core 3.6.2

- When Start fails because a container died (for example `postgres exited (1)`), the tool now reads that
  container's log before its cleanup removes the container, shows the last lines in the job panel and under
  Build & test output, and says what they mean: database files from another PostgreSQL version, damaged
  database files after an unclean shutdown, a stale lock file, a full Docker disk, missing settings, a service
  that could not reach the database, or a container that ran out of memory.
- New **Reset local database** button (Live app & tests): removes the workspace's database volume so the next
  Start re-creates and re-seeds it. Available only while the stack is stopped; asks for confirmation.
- New **Free Docker space** button: removes the images, database volumes and build cache left behind by earlier
  workspaces. Every Prepare creates a new image set of several GB and a new database volume, and nothing removed
  them before; a full Docker disk is one reason Docker Desktop stops opening. The current workspace is kept.

# TickTrade Intelligence Core 3.6.1

- A failed Docker command now explains itself in the job panel: exit code, a plain-language cause when it
  is recognizable (Docker Desktop not running or paused, registry unreachable, Docker Hub rate limit, disk full,
  permission refused) and the last lines of output. A build that dies instantly no longer leaves an empty
  "Live build output".
- When Docker Hub cannot be reached (offline, VPN, proxy), the build retries from the base images Docker
  already holds instead of failing.

# TickTrade Intelligence Core 3.6.0

Changes since 3.5.0:

## Code ZIP uploads
- ZIPs made from a working folder now import. Dependency, build and version-control folders
  (`node_modules`, `dist`, `build`, `.git`, ...) are ignored before any limit is applied instead of
  making the whole upload fail with "invalid or has too many entries".
- ZIPs made with the Finder (containing `__MACOSX`, `.DS_Store` and `._` files) import like a clean
  export; the real top folder is still stripped.
- Error messages say what is wrong and what to do: unreadable/corrupt archive, too many files
  (with the count), too large (with the size), instead of one generic message.
- The upload report lists the ignored folders and how many files each held.

## Diagnostics
- Every unexpected error is now written with its traceback to `data/logs/errors.log`
  (secrets redacted, rotated at 2 MB). Messages in the app name the error type and point to the log.
  This covers HTTP requests, code ZIP imports, document imports, Studio publication/rollback,
  engineering tasks and runtime (Docker) jobs.

## Studio
- Patch limits raised from 200 KB per file / 1 MB total to 2 MB per file / 4 MB total, so large
  files such as `apps/engine/src/npc/npc-simulator.service.ts` (702 KB) can now be changed.

## Launcher
- `Start TickTrade.command` prefers Homebrew Python 3.13/3.12/3.11 and prints which interpreter
  and which address it uses.

## Fixes from a full code review (29 findings checked, the ones below fixed)
Studio (working versions, candidates, apply/rollback)
- A working-version ZIP made with the Finder, or containing `node_modules`/`dist`/`.git`, imported as a
  baseline but could never be previewed or applied ("bytes do not match the candidate base file hash",
  "invalid or has too many entries"). The Studio now applies the same tolerant rules as the importer.
- One 2 MB per-file patch limit for every file (lockfiles included): a larger lockfile candidate could be
  created but never verified. Total stays 4 MB. Returned-JSON size limit raised to 7 MB (the server's cap).
- A preview interrupted by a force-quit left an empty `dev-*` folder that hid every working version and
  made rollback unreachable. Such folders are now skipped.
- Candidate paths that differ only by letter case from an existing file (a real collision on a Mac disk)
  are rejected up front instead of failing half-way through the write.
- The AI patch validator now allows the same 2 MB files as the Lab.

Model connection (Ollama / compatible server / OpenAI)
- The model service's own error text (for example Ollama's "model requires more system memory (9.1 GiB)
  than is available (6.2 GiB)" or "model not found, try pulling it first") and connection reasons are now
  written to `data/logs/errors.log`; the message shown in the app says so. They are still never shown
  raw in the interface.
- The per-request model timeout is a setting (`generation_timeout`, 30–900 s). The default is now
  600 s instead of a fixed 180 s, which a long prompt on a 16 GB Mac routinely exceeded.
- Switching from a Compatible server (whose URL ends in `/v1`) to OpenAI no longer rejects the saved
  URL while hiding the field to fix it.
- The engineering worker thread can no longer die silently (disk full, database locked) and leave every
  later task "queued" forever; the failure is recorded and logged.

Live app runtime (Docker)
- Stop and Logs no longer depend on input integrity: a `.DS_Store`, a `._` file or a temp file left by
  a force-quit made a running stack impossible to stop or re-prepare.
- A deleted or damaged runtime folder no longer disables every runtime endpoint; the pointer is set
  aside as `current.invalid.json`, a warning is shown, and the repositories can be prepared again.
- A failed browser smoke check is recorded as a result; it no longer shuts the running app down.
- Source folders named `env`, `build`, `vendor`, `target` and files such as `src/utils/compose.ts` are no
  longer dropped from the runtime copy (Docker builds failed with "Cannot find module").

Knowledge and imports
- Adding sources is atomic across the import worker and page requests (no more IntegrityError or two
  versions with the same number).
- Re-importing content identical to an archived version now reports a warning instead of a silent
  "duplicate".
- Splitting a 2-million-character document into passages took seconds; it is now linear.
- Code redaction preserves the line count, so line numbers in findings point at the right line.
- Text and HTML files in Shift-JIS, GBK, EUC-KR, Big5 or MacRoman no longer crash the importer.

## Known, not changed in this version
- Search cannot match words in scripts that use combining vowel signs (Hindi, vocalized Arabic, Hebrew
  with niqqud); plain Arabic and CJK work. Fixing it needs a search-index rebuild.
- Runtime folders, per-run Docker images and database volumes accumulate; remove old
  `data/runtime/runtime-*` folders and `ticktrade-local-*` images by hand when disk runs low.
- The chat question limit shown (12,000 characters) is larger than what the default context window
  actually allows (about 9,000 ASCII characters).
- The runtime log redaction blanks some harmless values (local URLs) along with secrets.
- An outer archive filename containing `:` is rejected on import; rename the file.
