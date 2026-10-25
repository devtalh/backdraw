# Security

## Supported versions

| Version | Supported |
|---|---|
| 2.0.x | Yes |
| 1.x ("ChatGPT image bridge") | No, please update |

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub:
the repository's **Security** tab → **Report a vulnerability**
([direct link](../../security/advisories/new)). If that button is missing, open an issue that only
asks for a private contact, with no details of the problem, and you will get one.

Include what you found, how to reproduce it and the Backdraw version. If you paste output of
`node cli.js status` or `diagnose`, remove your paths, project names and prompts first.

## What Backdraw is

Backdraw lets an MCP client (Claude Code, the Claude desktop app or another one) generate images with
the user's own ChatGPT account. Four pieces, all on the user's PC:

| Piece | Runs as | Talks to |
|---|---|---|
| `mcp-server.js` | a child process of the MCP client (stdio) | `host.js`, over a named pipe |
| `host.js` | the native messaging host Chrome starts for the extension | the extension (native messaging) and the pipe |
| Chrome extension | MV3 service worker plus a background tab on chatgpt.com | `host.js` and chatgpt.com |
| `cli.js` | started by hand, for setup and troubleshooting | `host.js`, over the named pipe |

## Threat model

Treated as untrusted:

- web pages, including chatgpt.com and any site where you right-click an image;
- content the assistant reads while it works (documents, web pages, repositories), which may try
  to steer its tool calls (prompt injection);
- other Windows users on the same PC.

Out of scope:

- malware that already runs as your Windows user (it can read your files and browser profile
  anyway);
- what OpenAI does with the prompts and images you send to ChatGPT.

## How Backdraw is protected

### The local bridge

- The MCP server and the CLI reach the host through a named pipe for your Windows user
  (`\\.\pipe\backdraw-<user name>`). There is no TCP or HTTP port, and web pages cannot open named
  pipes. Programs that run as you can use the pipe, the same as they can use your files.

### Native messaging

- Chrome starts the host only for the extension listed in the host manifest's `allowed_origins`:
  exactly one extension ID, fixed by the `key` in `extension/manifest.json`. Web pages and other
  extensions cannot connect to it.
- The registration is per user (HKCU); no admin rights are used.

### Calls from the extension to the host

- The extension's own requests to the host go through an allow-list (`EXTENSION_METHODS` in
  `lib/collections.js`): the collection methods (list, add, rename, delete, delete an image,
  thumbnails) and the gallery methods (list, thumbnail, show in folder, add to a collection). The
  extension cannot start jobs, run diagnostics or change the folders that way.
- A project chosen in the popup must be a ChatGPT project: the host only stores a
  `https://chatgpt.com/g/g-p-…` project link.
- **The host never takes a file path from the extension.** Collection folders and file names are
  made by the host; gallery actions name an image only by its job id and index, and the host
  checks that the file still exists.
- Collection names are sanitised: no path separators, reserved or control characters, no leading or
  trailing dots or spaces, Windows device names such as `CON` or `NUL` get a suffix, at most 64
  characters. Every path is checked to stay inside the collections folder.
- Collection images must really be PNG, JPEG, WebP or GIF (checked by their file signature) and at
  most 25 MB.
- The service worker accepts messages only from the extension itself; web pages cannot send them.

### Your ChatGPT session

- The extension has no `cookies` permission and never reads cookies, tokens, passwords or ChatGPT's
  session endpoint. It reads the page in its own background tab and dispatches synthetic events
  there; it never moves your real mouse or keyboard.
- **Logins and CAPTCHAs are never automated or worked around.** When ChatGPT shows one, the job reports
  `NEEDS USER ACTION` and waits up to 10 minutes for you to complete it yourself.
- Jobs only open `https://chatgpt.com/` links: the host refuses any other `conversation_url`.

### Extension permissions

| Permission | Used for |
|---|---|
| `nativeMessaging` | the connection to the local host |
| `scripting` | running `extension/inpage.js` in its own ChatGPT tab; reading a right-clicked image inside its page; the confirmation note |
| `storage` | its background tab and a pending **New collection…** click (the image's and the page's address), until Chrome closes; your language and theme settings, the result of the last ChatGPT sign-in check and whether setup was finished |
| `alarms` | reconnecting to the host once a minute while it is not connected |
| `contextMenus` | the **Add to Backdraw** menu on images |
| `sidePanel` | the gallery side panel |
| `https://chatgpt.com/*`, `https://*.oaiusercontent.com/*` | ChatGPT and the image files it serves |
| `<all_urls>` | only to download an image you right-click and to show the confirmation note on that page |

Backdraw is not distributed through the Chrome Web Store: you load it unpacked from your own install
folder, so you can read every file Chrome runs. The right-click download is a normal request to the
image's address (Chrome sends that site's cookies with it as usual; Backdraw does not read them).

## Prompt injection: `reference_images`

`generate_image` takes `reference_images`: the MCP client can attach **any local file whose name
ends in `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif`** (only the name is checked, not the contents; up
to 20 MB each, 80 MB and 16 files per message) to a ChatGPT message.
A malicious document, web page or repository could try to make the assistant attach private images
(screenshots, scanned documents, photos) and so upload them to ChatGPT. In the same way,
`output_dir` lets it copy results into any folder.

- Review Backdraw's tool calls before you approve them, especially `reference_images`.
- Keep auto-approval off for Backdraw while the assistant works with content you don't trust.
- Everything Backdraw sends ends up in your ChatGPT history, where you can check it.

## Data on disk

| Where | What |
|---|---|
| `%USERPROFILE%\.backdraw\data\config.json` | the selected ChatGPT Project, the images and collections folders, the debug switch |
| `%USERPROFILE%\.backdraw\data\jobs.json` | the last 100 jobs, with prompts, chat links and file paths |
| `%USERPROFILE%\.backdraw\data\previews\` | small JPEG previews, deleted after 7 days |
| `%USERPROFILE%\.backdraw\logs\host.log` | the host log, with the start of each prompt (more with `node cli.js debug on`) |
| `Pictures\Backdraw\` | generated images |
| `Pictures\Backdraw\References\` | reference collections |

Reference images an MCP client sends are kept in memory only until their job ends. None of this is
uploaded anywhere by Backdraw, and uninstalling leaves it in place.
