# Per-run virtual files

A gateway execution may include an optional `files` array alongside `code`, `input`, and `language`:

```json
{"files":[{"path":"src/input.txt","base64":"aGVsbG8="}]}
```

The worker and Mac gateway independently enforce the same contract: at most 8 files, at most 256 KiB per decoded file, at most 1 MiB decoded total, and at most 1.6 MB for the serialized job. Paths must be canonical relative POSIX paths (maximum 240 characters); absolute paths, empty/dot/dot-dot/hidden path segments, backslashes, colons, control characters, duplicates, file/directory collisions, non-canonical base64, and extra object fields are rejected. A file bundle cannot carry symlink targets, modes, commands, images, environment values, or mount instructions. Base64 length is bounded before decoding.

The fixed Node image runs with `--network none`, a read-only image, dropped capabilities, non-root UID, and no host mounts. A per-run 16 MiB `/tmp` tmpfs contains `/tmp/honmaru-work`; files are created exclusively with mode 0600 and execution changes to this directory. Container removal in the runner's `finally` path cleans the tmpfs after success, failure, timeout, or cancellation. The existing Simple workflow and jobs without files use their prior input behavior.