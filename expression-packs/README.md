# Built-in expression packs

This directory is mounted read-only into the API container at `/app/expression-packs`.
Each subdirectory is named after one Echo server ID and contains `manifest.json` plus
the image files listed by that manifest. Synchronize a pack with:

```bash
docker compose exec api node /app/scripts/sync-expression-packs.js
```

See `server-squad/manifest.json` for the manifest shape. Supported image formats are
PNG, JPEG, GIF and WebP. Per-image limits are 256 KiB for emoji and 2 MiB for stickers.
Built-in groups are read-only in the UI. Removing an item from a manifest hides it from
the picker while preserving historical sticker messages. Keep the source images here
as well as the Echo uploads volume; the files in this directory are the backup/source.
