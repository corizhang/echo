# Bot-only sticker packs

This folder is mounted read-only at `/app/ai-sticker-packs`. Create one subfolder per
AI agent ID, with a `manifest.json` and image files. `api/scripts/sync-ai-sticker-packs.js`
copies validated images to the persistent uploads volume and updates the bot-only catalog.

```bash
docker compose exec api node /app/scripts/sync-ai-sticker-packs.js
```

The bot catalog is kept separate from user emoji/stickers. Supports PNG/JPEG/GIF/WebP,
up to 2 MiB per image. Removing an item from the manifest makes it unavailable to future
bot replies while preserving images already sent in chat history.
