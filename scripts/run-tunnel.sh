#!/bin/bash
# Run cloudflared tunnel using the user's config
# Expects tunnel ID as first argument, or reads from ~/.cloudflared/config.yml
# Auto-detect cloudflared binary (works on both macOS and Linux)
CLOUDFLARED=$(command -v cloudflared 2>/dev/null || echo "/opt/homebrew/bin/cloudflared")
exec "$CLOUDFLARED" tunnel --config "$HOME/.cloudflared/config.yml" run "$@"
