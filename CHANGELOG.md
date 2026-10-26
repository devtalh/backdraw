# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.2] - 2026-10-26

### Added

- `generate_image` takes an optional `filename_hint`: a few words naming the subject, used for the
  saved file name instead of the start of the prompt. A prompt that opens with instructions about
  the reference images (common with collections) no longer names the file
  `…_use-the-attached-reference-images-…`.

### Changed

- After a successful image, the server instructions and the SUCCESS result ask the client to show
  the saved image to the user in the chat when it can display or share a local file, and otherwise
  to give the path clearly. Some clients show the attached preview only as a small icon.

## [2.1.1] - 2026-10-25

### Added

- `backdraw mcp` runs the MCP server on stdio, so clients can start it with
  `npx backdraw@latest mcp` (through `cmd /c` on Windows).
- **Claude Code plugin and marketplace:** `/plugin install backdraw --marketplace devtalh/backdraw`
  adds the server; `/backdraw:setup` explains the one-time browser step.
- **Official MCP Registry** entry `io.github.devtalh/backdraw` (`server.json`, `mcpName` in
  `package.json`).
- README (English and Turkish): "Install from your client", with the Claude Code plugin command,
  Add to Cursor and Install in VS Code buttons, and Codex and Gemini CLI lines.
- `setup --clients=none` sets up only the browser side (for clients that add the server
  themselves).
- `glama.json` for the Glama MCP directory.
- Releases are published by GitHub Actions when a `v*` tag is pushed: tests on Windows, npm with
  trusted publishing (OIDC, with provenance) and the MCP Registry with GitHub OIDC. No token is
  stored.

### Changed

- The npm package no longer restricts the OS. Directories that check MCP servers on Linux can start
  it and list its tools; setup and the tools themselves still say clearly that only Windows is
  supported.

## [2.1.0] - 2026-10-25

### Added

- **One-command install: `npx backdraw@latest setup`.** Backdraw is now an npm package (`backdraw`)
  with a `backdraw` command. Setup copies the files to `%USERPROFILE%\.backdraw` (npx's copy is
  temporary), keeps your settings, history and collections on an update, registers the browsers,
  adds Backdraw to the MCP clients you pick, opens the extension folder and the extensions page,
  copies the folder path, and waits (up to 3 minutes, Ctrl+C skips) until the extension connects.
  Loading the extension is the only step left to you. `--yes`, `--clients=…`, `--browser=…`,
  `--no-wait`.
- **More MCP clients:** besides Claude Code and the Claude desktop app, setup adds Backdraw to
  Codex (`~\.codex\config.toml`), Cursor (`~\.cursor\mcp.json`), VS Code (the user `mcp.json`) and
  Gemini CLI (`~\.gemini\settings.json`), in the formats of their docs. Each file gets a timestamped
  `.bak` copy first and only the `backdraw` entry changes; a JSON file with comments is left alone.
  A small, tested TOML editor (no dependency) handles Codex's file.
- **More browsers:** the native host is registered for Chrome, Edge, Brave and Chromium, under the
  key each one reads first (Brave has no key of its own; it reads Chromium's, then Chrome's). Only
  Chrome is tested.
- **`backdraw doctor [--fix]`:** checks Node.js, the install folder and versions, the host manifest,
  each browser's real registry entry (through WMI) and enterprise policies
  (`NativeMessagingUserLevelHosts`, `NativeMessagingBlocklist`), the bridge, the extension, the
  ChatGPT sign-in, the selected project and every client's entry; each line ✓ / ⚠ / ✗ with a fix.
  `--fix` rewrites the registrations and client entries it can. The output masks the home folder
  as `~` and can be pasted into an issue.
- `backdraw uninstall [--dry-run]` also removes the new browser keys and client entries.
- The host answers `chatgpt_state` (the sign-in state the extension last saw), for doctor.
- CLI flags also take `--flag=value`.

### Changed

- `node install.js` keeps working as before (Claude Code only); `backdraw status` and the other
  `cli.js` commands work through `npx backdraw <command>` too.
- README (English and Turkish): the quick install first, the manual install below it, and a Doctor
  section.

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
