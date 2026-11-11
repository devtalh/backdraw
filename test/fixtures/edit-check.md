# Edit check fixtures

Small regression copies of five MF MET test images, included with the project owner's permission
for LEA-279. Each PNG has a maximum dimension of 192 pixels and is smaller than 60 KiB. The
full-size source images are not included.

- `edit-spreader-gray.png` and `edit-spreader-red.png`: gray welded frame to finished red spreader.
- `edit-weld-1.png` and `edit-weld-2.png`: welding sparks change in a nearly identical composition.
- `edit-spreader-red.png` and `edit-proud-welder.png`: a welder is added and the spreader moves.
- `edit-weld-1-jpeg90.png`: JPEG quality 90 re-encoding of `edit-weld-1.png`, decoded to PNG so
  the browser-free tests can exercise real lossy codec noise without a JPEG dependency.

The source PNGs were resized with high-quality bicubic filtering and mirrored edge sampling,
preserving opaque image borders. Tests also re-encode all five PNGs losslessly at runtime.
