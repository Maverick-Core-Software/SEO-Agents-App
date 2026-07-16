# Reference images for image-to-video (I2V) generation
#
# Each image serves as the first frame for xAI Grok Imagine I2V video generation.
# Files are named by service slug (e.g., panel-upgrade.jpg) and resolved by
# resolveReferenceImage() in facebook-poster.mjs.
#
# To generate new images:
#   node scripts/generate-reference-image.mjs --service "panel-upgrade" \
#     --output assets/reference-images/panel-upgrade.jpg
#
# Or with a custom prompt:
#   node scripts/generate-reference-image.mjs --prompt "your prompt here" \
#     --output assets/reference-images/custom.jpg
