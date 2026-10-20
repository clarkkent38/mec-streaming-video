# Icons

Place the following files here before building the installer:

| File | Size | Used by |
|---|---|---|
| `icon.ico` | 256×256 (multi-res ICO with 16/32/48/256 sizes) | NSIS installer, EXE icon, taskbar |
| `icon.png` | 512×512 PNG | Electron `nativeImage` for tray (auto-converted) |

## Quick way to generate a placeholder ICO for testing

```powershell
# Install ImageMagick (if not already) then:
magick -size 256x256 xc:#2563eb -fill white -pointsize 80 \
  -gravity center -annotate 0 "⬡" icon.png
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

Or use https://favicon.io/favicon-generator/ with the ⬡ character on a blue background.
