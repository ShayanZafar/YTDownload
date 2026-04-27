## Packages

framer-motion | Page transitions and layout animations
date-fns | Human-readable date formatting

## Notes

Tailwind Config - extend fontFamily:
fontFamily: {
sans: ["var(--font-sans)"],
display: ["var(--font-display)"],
}

Implementation detail: Download uses native browser anchor navigation instead of fetch/XHR to handle the file stream properly.
