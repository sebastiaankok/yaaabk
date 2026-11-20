# Personal Bookmarks

A small page that lists saved bookmarks.

## What to build

A bookmark list with a card, a focus ring on every control, and a title that
tracks the browser theme.

## Acceptance criteria

- Read the page at 1280px and 375px wide. Confirm that the card centres and the
  header reads clearly.
- Tab through the page and confirm that every control shows a focus ring.
- Open the page in light mode and in dark mode. Confirm that the page title
  shows in the tab.
- Force an API failure and confirm that the alert appears.

## Implementation Decisions

Store bookmarks in SQLite and serve them from a small Bun server.
