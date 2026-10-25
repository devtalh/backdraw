# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-10-25

### Changed

- The repository moved to [github.com/devtalh/backdraw](https://github.com/devtalh/backdraw) (the
  GitHub user was renamed). `package.json` now names the repository, homepage, issue tracker and
  keywords, and the license and author name `devtalh`.
- The native host keeps its name `io.github.muhammedtalha04.backdraw`, so existing installs keep
  working without a re-install.
- README (English and Turkish): a "Why Backdraw?" section with a comparison to similar projects,
  manual setup examples for Codex, Cursor, VS Code and Gemini CLI, a `git clone` command, and a
  longer disclaimer on personal use, OpenAI's terms and the risk to your account.
- The demo video's closing card shows the new repository address.
- The result for a login or human-verification page and the server instructions now say "don't try
  to get around it" in plainer words; the behaviour is unchanged.

### Added

- `branding/social/backdraw-social-preview.png`, a 1280×640 image for the repository's social
  preview.

## [2.0.0] - 2026-10-21

The ChatGPT image bridge is now **Backdraw**.

### Added

- **Reference collections.** Right-click an image in Chrome → **Add to Backdraw** → a collection or
  **New collection…**. Each collection is a folder under `Pictures\Backdraw\References` with a
  `collection.json` manifest and thumbnails; the same image is kept once, and formats ChatGPT
  can't take are saved as PNG. A short note in the page confirms each add.
- `list_collections` tool, and `reference_collection` / `reference_files` on `generate_image`: the
  newest images of a collection are attached after any `reference_images`, or the files you pick.
- CLI: `collections`, `collection <name>` and `generate --collection NAME [--file FILE]...`.
- Popup section to browse collections, delete images and rename or delete collections.
- `aspect_ratio` on `generate_image` and `fetch_images` (`W:H` from 1:4 to 4:1). ChatGPT draws 1:3
  to 3:1 itself; wider or taller shapes are drawn at 3:1 / 1:3 and cropped from the centre. A
  cropped image is the main file and ChatGPT's original is kept as `<name>_full`. CLI: `--aspect`.
- `transparent_background`, with a check of the saved image (PNG alpha channel or `tRNS`, share of
  transparent pixels) and a warning when the background is not transparent. Transparent previews
  are drawn over a checkerboard. CLI: `--transparent`.
- **Fast return.** `generate_image`, `fetch_images` and `job_status` return within 45 seconds by
  default, so each call fits a 60-second tool-call limit. `STILL RUNNING` and `QUEUED` results name
  the job (and the queue position) and say to call `job_status` again.
- MCP revision 2026-07-28 (stateless: per-request `_meta` version, `server/discover`, `resultType`,
  cache hints, error `-32022` for an unsupported version), next to the legacy `initialize`
  handshake for 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05. JSON-RPC batches.
- `notifications/cancelled` stops a waiting tool call (the job itself keeps running).
- **Setup wizard** in a redesigned popup: bridge connected, signed in to ChatGPT, Project selected
  and an example prompt to copy, each step with its fix. Language (Auto / English / Türkçe) and
  theme (Auto / Light / Dark) settings.
- **Gallery side panel:** the job in progress, and the generated images newest first with
  **Open chat**, **Show in folder**, **Copy path** and **Add to collection**.
- `node install.js --desktop` adds Backdraw to the Claude desktop app's chat config, with a
  timestamped backup, and only while the app is closed.
- `node install.js --uninstall --dry-run` shows what would be removed without changing anything.
- English and Turkish extension UI, the right-click menu included; it follows the language setting.
- A test suite (`npm test`, built on `node:test`, no dependencies).

### Changed

- **Renamed to Backdraw.** The MCP server is `backdraw` (was `chatgpt-images`), the install folder
  is `%USERPROFILE%\.backdraw` (was `%USERPROFILE%\.claude\chatgpt-image-bridge`), the native host
  and the named pipe have new names, and new installs save images in `Pictures\Backdraw`. The
  extension ID is unchanged.
- `node install.js` migrates a 1.x install: it copies the settings and job history (never
  overwriting), removes the old native host and MCP entries, and leaves the old folder for you to
  delete.
- Up to 16 reference images per message (was 4), at most 80 MB together.
- Default `wait_seconds` is 45 for `generate_image` (was 300), `fetch_images` (was 180) and
  `job_status` (was 0).
- Everything the assistant reads (tool descriptions, results, errors), the CLI and the installer
  are in English.
- Windows-specific code moved into `platform/`, pure logic into `lib/`. The host and the MCP server
  read their version from `package.json`.
- Shorter installer output: a summary and numbered next steps only when something is left to do.
- `job_status`, `cancel_job` and `select_project` are annotated as idempotent.

### Fixed

- `job_status` and `fetch_images` were annotated as read-only although they save files;
  `cancel_job` is now marked destructive.
- A `null` `wait_seconds`, which some clients send for an omitted value, no longer means "don't
  wait".
- Notifications never get a response, and error responses no longer carry a `null` id.
- `initialize` answers with a protocol version the server supports instead of echoing any date.
- Images that 1.x saved only in a caller's folder are copied into the images folder once, on the
  first start; changing the images folder later no longer copies the whole history into it.

### Security

- The extension's calls to the host go through an allow-list, and the host never takes a file path
  from the extension; gallery actions name an image only by its job id and index.
  At most four image uploads from the extension are collected at a time.
- Collection folder and file names are made by the host and sanitised (Windows device names such as
  `CON` or `CONIN$` included), every path is checked to stay inside the collections folder, and
  saved images must really be PNG, JPEG, WebP or GIF.
- The new `<all_urls>` host permission is used only to download an image you right-click and to
  show the confirmation note.
- Added [SECURITY.md](SECURITY.md) with the threat model and how to report a vulnerability.

## [1.1.0]

The Turkish "Claude ↔ ChatGPT Görsel Köprüsü" (ChatGPT image bridge): its README, CLI, installer and
extension UI were in Turkish.

- MCP server `chatgpt-images` with `generate_image`, `job_status`, `cancel_job`, `fetch_images`,
  `list_projects` and `select_project`.
- Images generated in a background Chrome tab inside a selected ChatGPT Project, saved in one
  central folder.
- Up to 4 reference images, an edit check, `auto_reattach`, and the `NEEDS REFERENCE IMAGE` and
  `CHATGPT REPLIED WITHOUT AN IMAGE` results.
- Installed in `%USERPROFILE%\.claude\chatgpt-image-bridge`.
