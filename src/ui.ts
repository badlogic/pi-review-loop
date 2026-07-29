import { readFileSync } from "node:fs";

const reviewHtmlUrl = new URL("../web/dist/index.html", import.meta.url);

export function loadReviewHtml(options?: { needsCloseButton?: boolean }): string {
  let html = readFileSync(reviewHtmlUrl, "utf8");
  if (options?.needsCloseButton) {
    html = html.replace("</head>", `<script>window.__REVIEW_NEEDS_CLOSE=true;</script></head>`);
  }
  return html;
}
